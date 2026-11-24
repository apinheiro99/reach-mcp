import { generateIdentityKey, newNonce } from "@reach-mcp/shared/identity";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { WebSocketServer } from "ws";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BootstrapError } from "../src/bootstrap.ts";
import { parseClientArgs, startClient } from "../src/runtime.ts";
import { CliError } from "@reach-mcp/shared/cli";
import { SERVER_KEY, serverProof } from "./proof-fixture.ts";

const KEY = generateIdentityKey();
const CREDENTIAL = KEY.privateKey;

function bootstrapFile(endpoint: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "reach-client-rt-"));
  const file = path.join(dir, "bootstrap.env");
  writeFileSync(file, `REACH_SERVER_URL=${endpoint}\nREACH_CLIENT_ID=laptop\nREACH_CLIENT_IDENTITY_KEY=${CREDENTIAL}\nREACH_SERVER_TRUST_KEY=${SERVER_KEY.publicKey}\nREACH_ROOTS=${JSON.stringify([dir])}\n`);
  chmodSync(file, 0o600);
  return file;
}

test("client args: bootstrap and build are required, the insecure switch is explicit, nothing else is accepted", () => {
  assert.deepEqual(parseClientArgs(["--bootstrap", "b", "--build", "x"]), { bootstrap: "b", build: "x", allowInsecureWs: false });
  assert.equal(parseClientArgs(["--bootstrap", "b", "--build", "x", "--allow-insecure-ws"]).allowInsecureWs, true);
  for (const argv of [[], ["--bootstrap", "b"], ["--bootstrap", "b", "--build", "x", "--credential", CREDENTIAL], ["--bootstrap", "b", "--build", "x", "--url", "ws://x"]]) {
    assert.throws(() => parseClientArgs(argv), (e: unknown) => e instanceof CliError && !e.message.includes(CREDENTIAL));
  }
});

test("a ws:// endpoint is refused unless the explicit DEV switch is given, and the error carries no credential", () => {
  const file = bootstrapFile("ws://127.0.0.1:9/client");
  assert.throws(() => startClient({ bootstrap: file, build: "dev", allowInsecureWs: false }), (e: unknown) => e instanceof BootstrapError && !e.message.includes(CREDENTIAL));
  const running = startClient({ bootstrap: file, build: "dev", allowInsecureWs: true });
  assert.notEqual(running.transport.snapshot().state, "stopped", "started");
  assert.ok(!JSON.stringify(running.transport.snapshot()).includes(CREDENTIAL), "the snapshot has no credential");
  running.stop();
  assert.equal(running.transport.snapshot().state, "stopped");
});

test("the client process refuses bad arguments with a usage line and exit code 2, echoing no value", () => {
  const main = path.join(import.meta.dirname, "..", "src", "main.ts");
  const run = spawnSync(process.execPath, [main, "--bootstrap", "x", "--build", "y", "--credential", CREDENTIAL], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.ok(run.stderr.includes("usage: client") && !run.stderr.includes(CREDENTIAL));
  const missing = spawnSync(process.execPath, [main, "--bootstrap", path.join(tmpdir(), "no-such-bootstrap"), "--build", "y"], { encoding: "utf8" });
  assert.equal(missing.status, 2, "an unreadable bootstrap is a usage error, not a crash");
});

test("the client process exits with the dedicated refused code and a safe diagnostic when the Server refuses its build, instead of a silent clean exit", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  wss.on("connection", (socket) => {
    const challenge = newNonce();
    socket.send(JSON.stringify({ kind: "challenge", nonce: challenge }));
    socket.once("message", (data) => socket.send(JSON.stringify({ kind: "reject", error: { code: "INCOMPATIBLE_BUILD", message: "client build is not accepted" }, proof: serverProof("reject:INCOMPATIBLE_BUILD", String((JSON.parse(data.toString()) as { client_nonce?: string }).client_nonce), challenge) })));
  });
  const file = bootstrapFile(`ws://127.0.0.1:${(wss.address() as { port: number }).port}/client`);
  const main = path.join(import.meta.dirname, "..", "src", "main.ts");
  const child = spawn(process.execPath, [main, "--bootstrap", file, "--build", "old-build", "--allow-insecure-ws"], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const status = await new Promise<number | null>((resolve) => child.once("exit", resolve));
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  assert.equal(status, 3, "a distinct exit code the service unit does not restart on");
  assert.ok(stderr.includes("INCOMPATIBLE_BUILD") && stderr.includes("client build is not accepted"), stderr);
  assert.ok(!stderr.includes(CREDENTIAL), "the diagnostic never carries the private key");
});
