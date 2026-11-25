// The Client side of an explicit, operator-triggered update. It owns only what the unprivileged Client can and should do: resolve the
// Server's release manifest, select this platform's artifact by role/os/arch, download it and verify size and SHA-256, and stage the
// verified archive in the state directory. It never replaces its own files: the replacement is the installer's job, run by the platform
// lifecycle owner that the installer registered (a systemd path unit on Linux, a one-shot Scheduled Task on Windows). The Client only
// asks for it through `trigger`. Nothing is destroyed before a verified archive exists, and a failure stops before the trigger.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { verifyReleaseEnvelope } from "@reach-mcp/shared/identity";
import type { UpdateFailure } from "@reach-mcp/shared/wire";
import { writeApplyRequest } from "./apply-receipt.ts";
import type { ServerTrust } from "./bootstrap.ts";

export const UPDATE_DIR = "update";
/** Linux: creating this file in the update directory is the request the installer's path unit acts on. */
export const UPDATE_MARKER = "apply";
/** Windows: the one-shot task the installer registered; running it is the request. */
export const WINDOWS_UPDATE_TASK = "REACH Client Update";

export type UpdateReport = (state: "staging" | "restarting") => void;

/** What the updater needs from the Bootstrap, the only owner of the Client's persistent trust state. */
export type ReleaseTrust = { trust(): Readonly<ServerTrust>; acceptRelease(releaseEpoch: number, releaseDigest: string): void };

export type UpdaterOptions = {
  /** The pinned Server key and the highest accepted release epoch and digest; the envelope must verify against them before the manifest is read. */
  bootstrap: ReleaseTrust;
  /** The Server's Client endpoint from the bootstrap (ws://host:port/client); the release origin is derived from it, never configured. */
  endpoint: string;
  /** The Client's own build id: an update to the same build is refused as `current`, not repeated. */
  build: string;
  /** The attempt the Server minted; it is written into the apply request so the wrapper's terminal result correlates to it. The Client never mints one. */
  updateId: string;
  /** The directory holding the bootstrap; the staged archive goes to its `update` subdirectory. */
  stateDir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Test seams: the plain-http GET (no redirect, bounded size) and the platform trigger. */
  fetchBytes?: (url: string, maxBytes: number) => Promise<Buffer>;
  trigger?: (stageDir: string, platform: NodeJS.Platform) => Promise<void>;
};

export class UpdateError extends Error {
  readonly reason: UpdateFailure;
  constructor(reason: UpdateFailure) {
    super(`update failed: ${reason}`);
    this.reason = reason;
  }
}

const ARTIFACT_MAX_BYTES = 1_000_000_000;
const DOWNLOAD_PATH = /^\/release\/artifacts\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** ws://host:port/client -> http://host:port; wss and anything else is not a release origin this updater reads. */
export function releaseOrigin(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== "ws:") throw new UpdateError("unsupported");
  return `http://${url.host}`;
}

/** One fetch policy, the installers' own: plain http to the given origin only, no redirect, and never more than `maxBytes`. */
export function fetchBytes(url: string, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 600_000 }, (response) => {
      if (response.statusCode !== 200) return void reject(new Error("status")), response.resume();
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) return void request.destroy(new Error("too large"));
        chunks.push(chunk);
      });
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
  });
}

const ENVELOPE_MAX_BYTES = 2_000_000;
const B64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Verifies the Server-signed release envelope {release_epoch, manifest, signature} against the pinned key and returns the exact manifest text, or throws
 * UpdateError("manifest"). The signature covers the epoch and the exact manifest bytes, so nothing is parsed before it holds. A lower epoch is refused, and the
 * same epoch only with the same manifest digest; the accepted epoch and digest are persisted before the manifest is used, never after a failed check.
 */
export function openReleaseEnvelope(envelopeText: string, bootstrap: ReleaseTrust): string {
  const fail = () => new UpdateError("manifest");
  const held = bootstrap.trust();
  let envelope: { release_epoch?: unknown; manifest?: unknown; signature?: unknown };
  try {
    envelope = JSON.parse(envelopeText);
  } catch {
    throw fail();
  }
  const { release_epoch: epoch, manifest, signature } = envelope;
  if (held.serverKey === null || typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 1 || typeof manifest !== "string" || !B64URL.test(manifest) || typeof signature !== "string") throw fail();
  const bytes = Buffer.from(manifest, "base64url");
  if (bytes.toString("base64url") !== manifest || !verifyReleaseEnvelope(held.serverKey, epoch, bytes, signature)) throw fail();
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (epoch < held.releaseEpoch || (epoch === held.releaseEpoch && held.releaseDigest !== null && held.releaseDigest !== digest)) throw fail();
  if (epoch !== held.releaseEpoch || digest !== held.releaseDigest) {
    try {
      bootstrap.acceptRelease(epoch, digest);
    } catch {
      throw fail();
    }
  }
  return bytes.toString("utf8");
}

type Selected = { download_path: string; sha256: string; size_bytes: number; build: string };

/** The manifest selection every installer makes: schema v2, exactly one client artifact for this os/arch, strict field shapes. */
export function selectClientArtifact(manifestText: string, os: string, arch: string): Selected {
  let manifest: { schema_version?: unknown; client?: { build_id?: unknown }; artifacts?: unknown };
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new UpdateError("manifest");
  }
  const hits = (Array.isArray(manifest.artifacts) ? manifest.artifacts : []).filter((a) => a?.role === "client" && a.os === os && a.arch === arch);
  const artifact = hits[0];
  const build = manifest.client?.build_id;
  const valid =
    manifest.schema_version === 2 &&
    hits.length === 1 &&
    typeof artifact.download_path === "string" && DOWNLOAD_PATH.test(artifact.download_path) &&
    typeof artifact.sha256 === "string" && /^[0-9a-f]{64}$/.test(artifact.sha256) &&
    Number.isSafeInteger(artifact.size_bytes) && artifact.size_bytes > 0 && artifact.size_bytes <= ARTIFACT_MAX_BYTES &&
    typeof build === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(build);
  if (!valid) throw new UpdateError("manifest");
  return { download_path: artifact.download_path, sha256: artifact.sha256, size_bytes: artifact.size_bytes, build };
}

/** The platform's own request to its lifecycle owner; the Client holds no install logic and runs no installer itself. */
export function platformTrigger(stageDir: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === "win32") {
    return new Promise((resolve, reject) => execFile("schtasks.exe", ["/Run", "/TN", WINDOWS_UPDATE_TASK], { windowsHide: true }, (error) => (error ? reject(error) : resolve())));
  }
  writeFileSync(path.join(stageDir, UPDATE_MARKER), "");
  return Promise.resolve();
}

/**
 * Stages a verified replacement and asks the platform to apply it. Resolves after the request is made (the process may be replaced right
 * after); throws UpdateError with a closed reason before any request when something cannot be proven. One run per call: the Server allows one in flight.
 */
export async function runUpdate(options: UpdaterOptions, report: UpdateReport): Promise<void> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? (process.arch === "x64" ? "x64" : process.arch);
  const get = options.fetchBytes ?? fetchBytes;
  const trigger = options.trigger ?? platformTrigger;
  const origin = releaseOrigin(options.endpoint);
  report("staging");
  const envelope = await get(`${origin}/release/envelope`, ENVELOPE_MAX_BYTES).then((b) => b.toString("utf8"), () => Promise.reject(new UpdateError("manifest")));
  const selected = selectClientArtifact(openReleaseEnvelope(envelope, options.bootstrap), platform, arch);
  if (selected.build === options.build) throw new UpdateError("current");
  const bytes = await get(`${origin}${selected.download_path}`, selected.size_bytes).catch(() => Promise.reject(new UpdateError("artifact")));
  if (bytes.length !== selected.size_bytes || createHash("sha256").update(bytes).digest("hex") !== selected.sha256) throw new UpdateError("verification");
  const stageDir = path.join(options.stateDir, UPDATE_DIR);
  try {
    mkdirSync(stageDir, { recursive: true });
    rmSync(path.join(stageDir, UPDATE_MARKER), { force: true });
    const file = path.join(stageDir, platform === "win32" ? "client.zip" : "client.tgz");
    writeFileSync(`${file}.tmp`, bytes, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    writeApplyRequest(options.stateDir, { schema_version: 1, update_id: options.updateId, from_build: options.build, target_build: selected.build, artifact_sha256: selected.sha256 });
  } catch {
    throw new UpdateError("staging");
  }
  report("restarting");
  await trigger(stageDir, platform).catch(() => Promise.reject(new UpdateError("handoff")));
}
