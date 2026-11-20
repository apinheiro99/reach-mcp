import { generateIdentityKey } from "@reach-mcp/shared/identity";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BootstrapError } from "../src/bootstrap.ts";
import { parseClientArgs, startClient } from "../src/runtime.ts";
import { CliError } from "@reach-mcp/shared/cli";

const KEY = generateIdentityKey();
const CREDENTIAL = KEY.privateKey;

function bootstrapFile(endpoint: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "reach-client-rt-"));
  const file = path.join(dir, "bootstrap.env");
  writeFileSync(file, `REACH_SERVER_URL=${endpoint}\nREACH_CLIENT_ID=laptop\nREACH_CLIENT_IDENTITY_KEY=${CREDENTIAL}\nREACH_ROOTS=${JSON.stringify([dir])}\n`);
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
