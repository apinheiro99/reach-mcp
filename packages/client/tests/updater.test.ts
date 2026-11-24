// The Client side of the operator-triggered update: manifest selection, size and SHA-256 verification, staging before any request to the
// platform lifecycle owner, and the transport wiring (capability in the hello, one update at a time, closed failure reasons).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { generateIdentityKey, importPrivateKey, newNonce, signReleaseEnvelope } from "@reach-mcp/shared/identity";
import type { UpdateApplyResult } from "@reach-mcp/shared/wire";
import { SERVER_KEY, serverProof } from "./proof-fixture.ts";
import { ClientTransport, parseBootstrap, platformTrigger, releaseOrigin, runUpdate, openReleaseEnvelope, selectClientArtifact, UpdateError, type UpdaterOptions } from "../src/index.ts";

const ARCHIVE = Buffer.from("release-archive-bytes");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const artifact = (os: string, file: string, over: object = {}) => ({ role: "client", os, arch: "x64", download_path: `/release/artifacts/${file}`, sha256: sha(ARCHIVE), size_bytes: ARCHIVE.length, ...over });
const manifest = (over: object = {}, build = "build-2") => JSON.stringify({ schema_version: 2, client: { build_id: build }, artifacts: [artifact("linux", "reach-client-linux-x64.tgz", over), artifact("win32", "reach-client-win32-x64.zip")] });
const stateDir = () => mkdtempSync(path.join(tmpdir(), "reach-updater-"));

/** The Server-signed envelope the updater reads: {release_epoch, manifest, signature} over the exact manifest bytes. */
const envelopeOf = (manifestText: string, epoch = 1, key = SERVER_KEY): string => {
  const bytes = Buffer.from(manifestText);
  return JSON.stringify({ release_epoch: epoch, manifest: bytes.toString("base64url"), signature: signReleaseEnvelope(importPrivateKey(key.privateKey), epoch, bytes) });
};
const pinned = (extra = "") => parseBootstrap(`REACH_SERVER_URL=ws://127.0.0.1:8787/client\nREACH_CLIENT_ID=laptop-1\nREACH_CLIENT_IDENTITY_KEY=${generateIdentityKey().privateKey}\nREACH_SERVER_TRUST_KEY=${SERVER_KEY.publicKey}\n${extra}REACH_ROOTS=${JSON.stringify([tmpdir()])}`, { allowInsecureWs: true });

type Over = { manifest?: string; envelope?: string; bytes?: Buffer; build?: string; trigger?: () => Promise<void>; bootstrap?: ReturnType<typeof pinned> };
function setup(over: Over = {}) {
  const dir = stateDir();
  const calls: string[] = [];
  const states: string[] = [];
  const bootstrap = over.bootstrap ?? pinned();
  const options: UpdaterOptions = {
    bootstrap,
    endpoint: "ws://127.0.0.1:8787/client",
    build: over.build ?? "build-1",
    stateDir: dir,
    platform: "linux",
    arch: "x64",
    fetchBytes: async (url) => (calls.push(url), url.endsWith("/release/envelope") ? Buffer.from(over.envelope ?? envelopeOf(over.manifest ?? manifest())) : (over.bytes ?? ARCHIVE)),
    trigger: async () => {
      calls.push("trigger");
      await over.trigger?.();
    },
  };
  return { dir, calls, states, bootstrap, run: () => runUpdate(options, (s) => states.push(s)), staged: path.join(dir, "update", "client.tgz") };
}
const failsWith = (promise: Promise<void>, reason: string) => assert.rejects(promise, (e: unknown) => e instanceof UpdateError && e.reason === reason);

test("update: the manifest selects this platform's artifact, the verified archive is staged, and only then is the platform asked", async () => {
  const t = setup();
  await t.run();
  assert.deepEqual(t.calls, ["http://127.0.0.1:8787/release/envelope", "http://127.0.0.1:8787/release/artifacts/reach-client-linux-x64.tgz", "trigger"]);
  assert.deepEqual(t.states, ["staging", "restarting"]);
  assert.deepEqual(readFileSync(t.staged), ARCHIVE);
  assert.equal(existsSync(`${t.staged}.tmp`), false);
});

test("update: a wrong hash or size, a bad manifest or the same build stop before the platform is asked and stage nothing", async () => {
  const cases: [string, Over, string][] = [
    ["hash", { bytes: Buffer.from("tampered-archive-by"), manifest: manifest({ size_bytes: 19 }) }, "verification"],
    ["size", { bytes: Buffer.from("short") }, "verification"],
    ["manifest", { manifest: "{not json" }, "manifest"],
    ["schema", { manifest: JSON.stringify({ schema_version: 1 }) }, "manifest"],
    ["path", { manifest: manifest({ download_path: "http://elsewhere/x" }) }, "manifest"],
    ["current", { build: "build-2" }, "current"],
  ];
  for (const [name, over, reason] of cases) {
    const t = setup(over);
    await failsWith(t.run(), reason);
    assert.equal(t.calls.includes("trigger"), false, `${name}: nothing was asked of the platform`);
    assert.equal(existsSync(t.staged), false, `${name}: nothing was staged`);
  }
  assert.throws(() => releaseOrigin("wss://host/client"), (e: unknown) => e instanceof UpdateError && e.reason === "unsupported");
});

test("update: the envelope must verify against the pinned key before the manifest is read, and a failure advances nothing", async () => {
  const other = generateIdentityKey();
  const tampered = JSON.parse(envelopeOf(manifest())) as { manifest: string; release_epoch: number; signature: string };
  const swapped = { ...tampered, manifest: Buffer.from(manifest({ sha256: "a".repeat(64) })).toString("base64url") };
  const cases: [string, Over][] = [
    ["wrong signing key", { envelope: envelopeOf(manifest(), 1, other) }],
    ["manifest replaced after signing", { envelope: JSON.stringify(swapped) }],
    ["epoch changed after signing", { envelope: JSON.stringify({ ...tampered, release_epoch: 2 }) }],
    ["plain manifest where an envelope is required", { envelope: manifest() }],
    ["no pin", { bootstrap: parseBootstrap(`REACH_SERVER_URL=ws://127.0.0.1:8787/client\nREACH_CLIENT_ID=laptop-1\nREACH_CLIENT_IDENTITY_KEY=${generateIdentityKey().privateKey}\nREACH_ROOTS=${JSON.stringify([tmpdir()])}`, { allowInsecureWs: true }) }],
  ];
  for (const [name, over] of cases) {
    const t = setup(over);
    await failsWith(t.run(), "manifest");
    assert.equal(t.calls.includes("trigger"), false, `${name}: nothing was asked of the platform`);
    assert.deepEqual(t.calls.filter((c) => c.includes("/artifacts/")), [], `${name}: no artifact was downloaded`);
    assert.equal(t.bootstrap.trust().releaseEpoch, 0, `${name}: no epoch was accepted`);
  }
});

test("update: epoch freshness: a valid envelope persists epoch and digest, lower or same-epoch-other-digest is refused, a greater epoch with older bytes is accepted", async () => {
  const digest = (m: string) => createHash("sha256").update(m).digest("hex");
  const first = setup();
  await first.run();
  assert.equal(first.bootstrap.trust().releaseEpoch, 1);
  assert.equal(first.bootstrap.trust().releaseDigest, digest(manifest()));
  const held = (epoch: number, m: string) => pinned(`REACH_RELEASE_EPOCH=${epoch}\nREACH_RELEASE_DIGEST=${digest(m)}\n`);
  const lower = setup({ bootstrap: held(5, manifest()), envelope: envelopeOf(manifest(), 4) });
  await failsWith(lower.run(), "manifest");
  assert.equal(lower.bootstrap.trust().releaseEpoch, 5, "a refused envelope leaves the accepted epoch alone");
  const sameOtherDigest = setup({ bootstrap: held(5, manifest()), envelope: envelopeOf(manifest({}, "build-3"), 5) });
  await failsWith(sameOtherDigest.run(), "manifest");
  const sameSame = setup({ bootstrap: held(5, manifest()), envelope: envelopeOf(manifest(), 5) });
  await sameSame.run();
  assert.equal(sameSame.bootstrap.trust().releaseEpoch, 5);
  const rollback = setup({ bootstrap: held(5, manifest({}, "build-9")), envelope: envelopeOf(manifest({}, "build-1.5"), 6), build: "build-9" });
  await rollback.run();
  assert.equal(rollback.bootstrap.trust().releaseEpoch, 6, "an intentional rollback is newly signed metadata with a greater epoch");
});

test("update: openReleaseEnvelope returns the exact manifest text only after the signature, and ignores nothing it cannot prove", () => {
  const b = pinned();
  assert.equal(openReleaseEnvelope(envelopeOf(manifest()), b), manifest());
  assert.throws(() => openReleaseEnvelope("{not json", b), UpdateError);
  assert.throws(() => openReleaseEnvelope(JSON.stringify({ release_epoch: 0, manifest: "", signature: "" }), b), UpdateError);
});

test("update: a failed platform request is reported as a handoff failure", async () => {
  const t = setup({ trigger: () => Promise.reject(new Error("refused")) });
  await failsWith(t.run(), "handoff");
});

test("update: the Linux request is the marker file the installer's path unit watches, and a stale marker is cleared before staging", async () => {
  const dir = stateDir();
  mkdirSync(path.join(dir, "update"));
  await platformTrigger(path.join(dir, "update"), "linux");
  assert.equal(existsSync(path.join(dir, "update", "apply")), true);
  const t = setup({ trigger: async () => assert.equal(existsSync(path.join(t.dir, "update", "apply")), false, "cleared before the new request") });
  mkdirSync(path.join(t.dir, "update"));
  writeFileSync(path.join(t.dir, "update", "apply"), "");
  await t.run();
});

test("update: selectClientArtifact requires exactly one artifact for the os and arch", () => {
  assert.equal(selectClientArtifact(manifest(), "linux", "x64").build, "build-2");
  assert.throws(() => selectClientArtifact(manifest(), "linux", "arm64"), UpdateError);
});

test("transport: the hello says update_capable with an updater, and the command runs one update at a time with a closed failure reason", async () => {
  const key = generateIdentityKey();
  const bootstrap = (port: number) => parseBootstrap(`REACH_SERVER_URL=ws://127.0.0.1:${port}/ws\nREACH_CLIENT_ID=laptop-1\nREACH_CLIENT_IDENTITY_KEY=${key.privateKey}\nREACH_SERVER_TRUST_KEY=${SERVER_KEY.publicKey}\nREACH_ROOTS=${JSON.stringify([tmpdir()])}`, { allowInsecureWs: true });
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const frames: Record<string, unknown>[] = [];
  wss.on("connection", (s) => {
    const challenge = newNonce();
    s.send(JSON.stringify({ kind: "challenge", nonce: challenge }));
    s.on("message", (d) => {
      const f = JSON.parse(d.toString()) as Record<string, unknown>;
      frames.push(f);
      if (f.kind === "auth_begin") return void s.send(JSON.stringify({ kind: "server_auth", proof: serverProof("auth", String(f.client_nonce), challenge) }));
      if (f.kind !== "hello") return;
      s.send(JSON.stringify({ kind: "welcome", server_build: "srv", compatible: true, proof: serverProof("welcome", String(f.client_nonce), challenge) }));
      s.send(JSON.stringify({ kind: "update", update_id: "update-1" }));
      s.send(JSON.stringify({ kind: "update", update_id: "update-2" }));
    });
  });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const port = (wss.address() as { port: number }).port;
  let runs = 0;
  const transport = new ClientTransport(bootstrap(port), {
    build: "build-1",
    handler: { applyPolicy: () => undefined, handle: () => Promise.reject(new Error("unused")) },
    updater: async (report) => {
      runs++;
      report("staging");
      await new Promise((r) => setTimeout(r, 40));
      throw new UpdateError("verification");
    },
  });
  transport.start();
  for (let i = 0; i < 400 && !frames.some((f) => f.state === "failed"); i++) await new Promise((r) => setTimeout(r, 5));
  transport.stop();
  await new Promise<void>((r) => wss.close(() => r()));
  assert.equal(frames.find((f) => f.kind === "hello")!.update_capable, true);
  assert.deepEqual(frames.filter((f) => f.kind === "update_state"), [{ kind: "update_state", update_id: "update-1", state: "staging" }, { kind: "update_state", update_id: "update-1", state: "failed", reason: "verification" }], "every state carries the id the Server minted");
  assert.equal(runs, 1, "the second command while one runs is ignored");
});

test("transport: the latest terminal apply receipt is reported after the welcome, as read; with none, nothing is reported and nothing is invented", async () => {
  const key = generateIdentityKey();
  const run = async (receipt: (() => UpdateApplyResult | null) | undefined) => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const frames: Record<string, unknown>[] = [];
    wss.on("connection", (s) => {
      const challenge = newNonce();
      s.send(JSON.stringify({ kind: "challenge", nonce: challenge }));
      s.on("message", (d) => {
        const f = JSON.parse(d.toString()) as Record<string, unknown>;
        frames.push(f);
        if (f.kind === "auth_begin") return void s.send(JSON.stringify({ kind: "server_auth", proof: serverProof("auth", String(f.client_nonce), challenge) }));
        if (f.kind === "hello") s.send(JSON.stringify({ kind: "welcome", server_build: "srv", compatible: true, proof: serverProof("welcome", String(f.client_nonce), challenge) }));
      });
    });
    await new Promise<void>((r) => wss.once("listening", () => r()));
    const port = (wss.address() as { port: number }).port;
    const bootstrap = parseBootstrap(`REACH_SERVER_URL=ws://127.0.0.1:${port}/ws\nREACH_CLIENT_ID=laptop-1\nREACH_CLIENT_IDENTITY_KEY=${key.privateKey}\nREACH_SERVER_TRUST_KEY=${SERVER_KEY.publicKey}\nREACH_ROOTS=${JSON.stringify([tmpdir()])}`, { allowInsecureWs: true });
    const transport = new ClientTransport(bootstrap, { build: "build-2", handler: { applyPolicy: () => undefined, handle: () => Promise.reject(new Error("unused")) }, ...(receipt ? { receipt } : {}) });
    transport.start();
    await new Promise((r) => setTimeout(r, 150));
    transport.stop();
    await new Promise<void>((r) => wss.close(() => r()));
    return frames.filter((f) => f.kind === "update_receipt");
  };
  const applied: UpdateApplyResult = { schema_version: 1, update_id: "update-1", from_build: "build-1", target_build: "build-2", artifact_sha256: "a".repeat(64), state: "applied" };
  assert.deepEqual(await run(() => applied), [{ kind: "update_receipt", receipt: applied }]);
  assert.deepEqual(await run(() => null), [], "no receipt on disk: nothing is reported, and reaching the target build is not turned into one");
  assert.deepEqual(await run(undefined), []);
});
