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
import type { UpdateFailure } from "@reach-mcp/shared/wire";

export const UPDATE_DIR = "update";
/** Linux: creating this file in the update directory is the request the installer's path unit acts on. */
export const UPDATE_MARKER = "apply";
/** Windows: the one-shot task the installer registered; running it is the request. */
export const WINDOWS_UPDATE_TASK = "REACH Client Update";

export type UpdateReport = (state: "staging" | "restarting") => void;

export type UpdaterOptions = {
  /** The Server's Client endpoint from the bootstrap (ws://host:port/client); the release origin is derived from it, never configured. */
  endpoint: string;
  /** The Client's own build id: an update to the same build is refused as `current`, not repeated. */
  build: string;
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

const MANIFEST_MAX_BYTES = 1_000_000;
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
  const selected = selectClientArtifact(await get(`${origin}/release/manifest`, MANIFEST_MAX_BYTES).then((b) => b.toString("utf8"), () => Promise.reject(new UpdateError("manifest"))), platform, arch);
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
  } catch {
    throw new UpdateError("staging");
  }
  report("restarting");
  await trigger(stageDir, platform).catch(() => Promise.reject(new UpdateError("handoff")));
}
