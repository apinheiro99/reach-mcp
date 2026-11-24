// The Client side of the operator-triggered update: manifest selection, size and SHA-256 verification, staging before any request to the
// platform lifecycle owner, and the transport wiring (capability in the hello, one update at a time, closed failure reasons).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import { generateIdentityKey, newNonce } from "@reach-mcp/shared/identity";
import { ClientTransport, parseBootstrap, platformTrigger, releaseOrigin, runUpdate, selectClientArtifact, UpdateError, type UpdaterOptions } from "../src/index.ts";

const ARCHIVE = Buffer.from("release-archive-bytes");
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const artifact = (os: string, file: string, over: object = {}) => ({ role: "client", os, arch: "x64", download_path: `/release/artifacts/${file}`, sha256: sha(ARCHIVE), size_bytes: ARCHIVE.length, ...over });
const manifest = (over: object = {}, build = "build-2") => JSON.stringify({ schema_version: 2, client: { build_id: build }, artifacts: [artifact("linux", "reach-client-linux-x64.tgz", over), artifact("win32", "reach-client-win32-x64.zip")] });
const stateDir = () => mkdtempSync(path.join(tmpdir(), "reach-updater-"));

type Over = { manifest?: string; bytes?: Buffer; build?: string; trigger?: () => Promise<void> };
function setup(over: Over = {}) {
  const dir = stateDir();
  const calls: string[] = [];
  const states: string[] = [];
  const options: UpdaterOptions = {
    endpoint: "ws://127.0.0.1:8787/client",
    build: over.build ?? "build-1",
    stateDir: dir,
    platform: "linux",
    arch: "x64",
    fetchBytes: async (url) => (calls.push(url), url.endsWith("/release/manifest") ? Buffer.from(over.manifest ?? manifest()) : (over.bytes ?? ARCHIVE)),
    trigger: async () => {
      calls.push("trigger");
      await over.trigger?.();
    },
  };
  return { dir, calls, states, run: () => runUpdate(options, (s) => states.push(s)), staged: path.join(dir, "update", "client.tgz") };
}
const failsWith = (promise: Promise<void>, reason: string) => assert.rejects(promise, (e: unknown) => e instanceof UpdateError && e.reason === reason);

test("update: the manifest selects this platform's artifact, the verified archive is staged, and only then is the platform asked", async () => {
  const t = setup();
  await t.run();
  assert.deepEqual(t.calls, ["http://127.0.0.1:8787/release/manifest", "http://127.0.0.1:8787/release/artifacts/reach-client-linux-x64.tgz", "trigger"]);
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
  const bootstrap = (port: number) => parseBootstrap(`REACH_SERVER_URL=ws://127.0.0.1:${port}/ws\nREACH_CLIENT_ID=laptop-1\nREACH_CLIENT_IDENTITY_KEY=${key.privateKey}\nREACH_ROOTS=${JSON.stringify([tmpdir()])}`, { allowInsecureWs: true });
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const frames: Record<string, unknown>[] = [];
  wss.on("connection", (s) => {
    s.send(JSON.stringify({ kind: "challenge", nonce: newNonce() }));
    s.on("message", (d) => {
      const f = JSON.parse(d.toString()) as Record<string, unknown>;
      frames.push(f);
      if (f.kind !== "hello") return;
      s.send(JSON.stringify({ kind: "welcome", server_build: "srv", compatible: true }));
      s.send(JSON.stringify({ kind: "update" }));
      s.send(JSON.stringify({ kind: "update" }));
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
  assert.equal(frames[0]!.update_capable, true);
  assert.deepEqual(frames.slice(1), [{ kind: "update_state", state: "staging" }, { kind: "update_state", state: "failed", reason: "verification" }]);
  assert.equal(runs, 1, "the second command while one runs is ignored");
});
