import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startClient } from "../../client/src/runtime.ts";
import { CliError } from "@reach-mcp/shared/cli";
import { importPrivateKey, publicKeyFromPrivate } from "@reach-mcp/shared/identity";
import WebSocket from "ws";
import { signedHello } from "./identity-fixture.ts";
import { parseServerArgs, startServer, type RunningServer } from "../src/runtime.ts";

const SRC = path.join(import.meta.dirname, "..", "src");
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const BEARER = "mcp-bearer-" + "Rk52Yd90";
const SECRET = "secret-" + "arg-Bn18";

const dirs = () => {
  const base = mkdtempSync(path.join(tmpdir(), "reach-runtime-"));
  return { base, config: path.join(base, "private", "config.json"), proposal: path.join(base, "private", "proposal.json"), logs: path.join(base, "logs") };
};
const argv = (d: ReturnType<typeof dirs>, extra: string[] = []) => ["--config", d.config, "--proposal", d.proposal, "--logs", d.logs, "--port", "0", "--admin-port", "0", "--build", "dev-1", ...extra];

test("server args: required flags, loopback defaults for both listeners, valid ports, nothing else accepted and no value echoed", () => {
  const d = dirs();
  const args = parseServerArgs(argv(d));
  assert.deepEqual([args.host, args.adminHost, args.build], ["127.0.0.1", "127.0.0.1", "dev-1"]);
  assert.equal(parseServerArgs(argv(d, ["--repository-commit", "abc"])).repositoryCommit, "abc");
  assert.equal(parseServerArgs(argv(d)).artifacts, undefined, "no artifacts directory unless one is given");
  assert.equal(parseServerArgs(argv(d, ["--artifacts", "/srv/releases"])).artifacts, "/srv/releases");
  assert.equal(parseServerArgs(argv(d)).adminUser, undefined, "the operator label is the page default unless one is given");
  assert.equal(parseServerArgs(argv(d, ["--admin-user", "Operator"])).adminUser, "Operator");
  assert.throws(() => parseServerArgs(argv(d, ["--enroll-from", "127.0.0.1"])), CliError, "trusted-network admission is gone: there is no flag for it");
  for (const bad of [[], argv(d).slice(2), [...argv(d), "--config", SECRET], [...argv(d), "--bearer", SECRET], argv(d).map((v) => (v === "0" ? "70000" : v)), argv(d).filter((v, i, a) => v !== "--admin-port" && a[i - 1] !== "--admin-port"), [...argv(d), "--host"]]) {
    assert.throws(() => parseServerArgs(bad), (e: unknown) => e instanceof CliError && !e.message.includes(SECRET));
  }
});

test("admin exposure: loopback and no live reload by default; leaving loopback needs a named peer list; live reload is an explicit DEV switch", () => {
  const d = dirs();
  const defaults = parseServerArgs(argv(d));
  assert.deepEqual([defaults.adminHost, defaults.devLiveReload, defaults.adminAllowFrom], ["127.0.0.1", false, undefined]);
  assert.equal(parseServerArgs(argv(d, ["--dev-live-reload"])).devLiveReload, true);
  assert.throws(() => parseServerArgs(argv(d, ["--admin-host", "0.0.0.0"])), CliError, "a non-loopback admin listener without a peer list is refused");
  const lan = parseServerArgs(argv(d, ["--admin-host", "0.0.0.0", "--admin-allow-from", "203.0.113.5"]));
  assert.deepEqual([lan.adminHost, lan.adminAllowFrom], ["0.0.0.0", "203.0.113.5"]);
  assert.equal(parseServerArgs(argv(d, ["--admin-host", "::1"])).adminHost, "::1", "loopback needs no peer list");
});

test("setup mode: with no config the admin works and the data plane fails closed; the first config opens it without a restart", async () => {
  const d = dirs();
  const server = await startServer(parseServerArgs(argv(d)));
  const data = `http://127.0.0.1:${server.port}`;
  const admin = `http://127.0.0.1:${server.adminPort}`;
  assert.equal(((await (await fetch(`${admin}/admin/api/state`)).json()) as { setup_mode: boolean }).setup_mode, true);
  assert.equal((await fetch(`${data}/health`, { headers: { Authorization: `Bearer ${BEARER}` } })).status, 503);
  assert.equal((await fetch(`${data}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${BEARER}` } })).status, 503);
  assert.equal((await fetch(`${admin}/admin/api/config`, { method: "PUT", body: JSON.stringify({ mcp_bearer: BEARER, clients: [] }) })).status, 200);
  const health = await fetch(`${data}/health`, { headers: { Authorization: `Bearer ${BEARER}` } });
  assert.equal(health.status, 200, "usable without a restart");
  assert.equal(((await health.json()) as { server_build: string }).server_build, "dev-1");
  await server.stop();
  await assert.rejects(fetch(`${data}/health`), "the service listener is closed");
  await assert.rejects(fetch(`${admin}/admin/api/state`), "the admin listener is closed");
  const logs = readdirSync(d.logs).map((f) => readFileSync(path.join(d.logs, f), "utf8")).join("\n");
  assert.match(logs, /runtime configuration is not active, setup mode/);
  assert.match(logs, /runtime server started build=dev-1/);
  assert.ok(!logs.includes(BEARER));
});

test("--artifacts wires the public release routes on the service listener of the real Server: manifest and artifact bytes with no credential, 404 without the flag", async () => {
  const d = dirs();
  const artifacts = path.join(d.base, "release");
  mkdirSync(artifacts);
  writeFileSync(path.join(artifacts, "manifest.json"), '{"release":"r-1"}');
  writeFileSync(path.join(artifacts, "reach-client-linux-x64.tar.gz"), "client-bytes");
  const withFlag = await startServer(parseServerArgs(argv(d, ["--artifacts", artifacts])));
  const service = `http://127.0.0.1:${withFlag.port}`;
  assert.equal(await (await fetch(`${service}/release/manifest`)).text(), '{"release":"r-1"}', "setup mode, no credential");
  assert.equal(await (await fetch(`${service}/release/artifacts/reach-client-linux-x64.tar.gz`)).text(), "client-bytes");
  assert.equal((await fetch(`http://127.0.0.1:${withFlag.adminPort}/release/manifest`)).status, 404, "never on the admin listener");
  await withFlag.stop();
  const withoutFlag = await startServer(parseServerArgs(argv(d)));
  assert.equal((await fetch(`http://127.0.0.1:${withoutFlag.port}/release/manifest`)).status, 404, "no artifacts source");
  await withoutFlag.stop();
});

test("Server and Client runtimes: unknown Client waits Pending, Enable admits it, Disable closes and refuses it, Rotate Key swaps the key and the old one is refused", async () => {
  const d = dirs();
  const server: RunningServer = await startServer(parseServerArgs(argv(d)));
  const data = `http://127.0.0.1:${server.port}`;
  const admin = `http://127.0.0.1:${server.adminPort}`;
  const root = mkdtempSync(path.join(tmpdir(), "reach-anchor-"));
  assert.equal((await fetch(`${admin}/admin/api/config`, { method: "PUT", body: JSON.stringify({ mcp_bearer: BEARER, clients: [] }) })).status, 200);
  const file = path.join(d.base, "bootstrap.env");
  writeFileSync(file, `REACH_SERVER_URL=ws://127.0.0.1:${server.port}/client\nREACH_ROOTS=${JSON.stringify([root])}\n`);
  chmodSync(file, 0o600);
  const wait = async (cond: () => Promise<boolean>) => {
    for (let i = 0; i < 160 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 50));
    return cond();
  };
  const connected = async () => ((await (await fetch(`${data}/health`, { headers: { Authorization: `Bearer ${BEARER}` } })).json()) as { clients: { connected: number } }).clients.connected;
  const list = async () => (await (await fetch(`${admin}/admin/api/clients`)).json()) as { clients: { client_id: string; status: string; online: boolean; fingerprint: string | null }[]; counts: Record<string, number> };
  const post = (suffix: string) => fetch(`${admin}/admin/api/clients/${encodeURIComponent(clientId)}/${suffix}`, { method: "POST" });
  const client = startClient({ bootstrap: file, build: "dev-1", allowInsecureWs: true });
  const stored = readFileSync(file, "utf8");
  const oldKey = /REACH_CLIENT_IDENTITY_KEY=(\S+)/.exec(stored)![1]!;
  const clientId = /REACH_CLIENT_ID=(\S+)/.exec(stored)![1]!;
  assert.equal(statSync(file).mode & 0o077, 0, "the identity file stays private");

  assert.equal(await wait(async () => (await list()).clients.length === 1), true, "the valid unknown identity registered itself");
  assert.deepEqual((await list()).counts, { total: 1, enabled: 0, pending: 1, disabled: 0, online: 0, offline: 1 });
  assert.equal(await connected(), 0, "Pending has no operational session");
  const config = readFileSync(d.config, "utf8");
  assert.ok(config.includes(clientId) && config.includes("public_key") && !config.includes(oldKey), "the Server holds the public key only");
  assert.ok(!JSON.stringify(client.transport.snapshot()).includes(oldKey));
  assert.equal((await post("rotate-key")).status, 409, "a Pending Client cannot rotate");

  assert.equal((await post("enable")).status, 200);
  assert.equal(await wait(async () => (await connected()) === 1), true, "Enable admits the same identity with no credential and no re-enrollment");
  assert.equal((await list()).clients[0]?.online, true);
  const firstFingerprint = (await list()).clients[0]!.fingerprint;

  assert.equal((await post("rotate-key")).status, 200);
  assert.equal(await wait(async () => (await list()).clients[0]?.fingerprint !== firstFingerprint), true, "the Server promoted the new public key after the Client proved it");
  assert.equal(await wait(async () => (await connected()) === 1), true, "the Client reconnected and proved the new key");
  const rotated = readFileSync(file, "utf8");
  const newKey = /REACH_CLIENT_IDENTITY_KEY=(\S+)/.exec(rotated)![1]!;
  assert.notEqual(newKey, oldKey);
  assert.equal(rotated.replace(newKey, oldKey), stored, "only the private key line changed");
  assert.equal(statSync(file).mode & 0o077, 0, "still private after rotation");
  assert.ok(!readFileSync(d.config, "utf8").includes(newKey) && !JSON.stringify(await list()).includes(newKey), "the private key never reaches the Server");

  const stranger = new WebSocket(`ws://127.0.0.1:${server.port}/client`);
  const reply = await new Promise<{ kind: string; error?: { code: string } }>((resolve) => {
    stranger.on("message", (m) => {
      const frame = JSON.parse(m.toString()) as { kind: string; nonce?: string; error?: { code: string } };
      if (frame.kind === "challenge") {
        const old = { privateKey: oldKey, publicKey: publicKeyFromPrivate(importPrivateKey(oldKey)), key: importPrivateKey(oldKey) };
        stranger.send(JSON.stringify(signedHello(old, clientId, frame.nonce!, { client_build: "dev-1" })));
      } else resolve(frame);
    });
  });
  assert.equal(reply.error?.code, "AUTH_FAILED", "the old key is refused");
  stranger.terminate();

  assert.equal((await post("disable")).status, 200);
  assert.equal(await wait(async () => (await connected()) === 0), true, "Disable closed the live session");
  assert.equal((await list()).clients[0]?.status, "disabled");
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(await connected(), 0, "a Disabled Client is refused on reconnect");
  assert.equal(client.transport.snapshot().lastError?.code, "CLIENT_DISABLED");
  assert.equal((await post("enable")).status, 200);
  assert.equal(await wait(async () => (await connected()) === 1), true, "re-enable restores access without any manual step");

  client.stop();
  await server.stop();
  const logs = readdirSync(d.logs).map((f) => readFileSync(path.join(d.logs, f), "utf8")).join("\n");
  assert.match(logs, new RegExp(`client registered pending client_id=${clientId}`));
  assert.match(logs, /action=register_pending/);
  assert.match(logs, /action=rotate_key/);
  assert.match(logs, /action=client_disable/);
  assert.ok(![oldKey, newKey, BEARER].some((x) => logs.includes(x)));
});

test("the real Server process starts in setup mode and exits cleanly on SIGTERM", async () => {
  const d = dirs();
  const child = spawn(process.execPath, [path.join(SRC, "main.ts"), ...argv(d)], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c: Buffer) => (out += c.toString()));
  for (let i = 0; i < 100 && !out.includes("listening"); i++) await new Promise((r) => setTimeout(r, 50));
  const port = /listening port=(\d+) admin_port=(\d+)/.exec(out);
  assert.ok(port, "announced its two ports");
  assert.equal(((await (await fetch(`http://127.0.0.1:${port[2]}/admin/api/state`)).json()) as { setup_mode: boolean }).setup_mode, true);
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  assert.equal(await exited, 0);
  await assert.rejects(fetch(`http://127.0.0.1:${port[1]}/health`));
  await assert.rejects(fetch(`http://127.0.0.1:${port[2]}/admin/api/state`));
});

test("the Server process refuses bad arguments with a usage line and exit code 2, echoing no value", () => {
  const run = spawnSync(process.execPath, [path.join(SRC, "main.ts"), "--config", "a", "--unknown", SECRET], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.ok(run.stderr.includes("usage: server") && !run.stderr.includes(SECRET));
});

test("composition owner audit: each owner is built once, in runtime.ts only", async () => {
  const { readdirSync: ls } = await import("node:fs");
  const files = [...ls(SRC, { recursive: true, encoding: "utf8" }).map((f) => path.join(SRC, f)), ...ls(path.join(ROOT, "packages", "client", "src")).map((f) => path.join(ROOT, "packages", "client", "src", f))].filter((f) => f.endsWith(".ts"));
  const count = (re: RegExp) => files.filter((f) => !f.endsWith("runtime.ts")).filter((f) => re.test(readFileSync(f, "utf8")));
  assert.deepEqual(count(/new ServerConfigStore\(|new ClientConnectionRegistry\(|new ProposalStore\(|new RotatingTextWriter\(|= createHttpServer\(|= createAdminHandler\(|= createReleaseHandler\(|new ClientTransport\(|new ClientDispatcher\(/), []);
  const runtime = readFileSync(path.join(SRC, "runtime.ts"), "utf8");
  for (const [name, expected] of [["new ServerConfigStore(", 1], ["new ClientConnectionRegistry(", 1], ["new ProposalStore(", 1], ["new RotatingTextWriter(", 2], ["createHttpServer({ ...common", 1], ["createAdminHandler(", 1], ["createReleaseHandler(", 1]] as const) {
    assert.equal(runtime.split(name).length - 1, expected, name);
  }
  assert.ok(!/process\.env|child_process|spawn|setInterval/.test(runtime), "no env contract, subprocess or supervisor loop");
});

test("DEV unit files: only the approved /reach layout, no credential, no obsolete path, no shell", () => {
  const units = ["reach-mcp-server.service", "reach-mcp-client.service"].map((n) => ({ n, text: readFileSync(path.join(ROOT, "deploy", "dev", n), "utf8") }));
  for (const { n, text } of units) {
    const exec = text.split("\n").find((l) => l.startsWith("ExecStart="));
    assert.ok(exec, `${n} has an ExecStart`);
    const installed = n.includes("client");
    assert.ok(exec.startsWith(installed ? "ExecStart=/usr/local/bin/node /opt/reach-mcp-client/reach-client.mjs " : "ExecStart=/usr/local/bin/node packages/"), "runs node directly, no shell; the Client runs the installed artifact, never the source tree");
    if (installed) assert.ok(!/packages\/|WorkingDirectory/.test(text.replace(/^#.*$/gm, "")), "no source checkout dependency in the Client unit");
    assert.ok(!/reach-private\/(client|server)\//.test(text), "private runtime files live under reach-private/runtime/");
    assert.ok(!/\/etc\/|\/var\/|\/reach\/runtime|reach\.env|client\.env|Environment|sh -c|credential=|token|password|secret/i.test(text.replace(/^#.*$/gm, "")), `${n}: no secret, env or obsolete path`);
    for (const p of exec.match(/(?<=\s)\/[A-Za-z0-9_./-]+/g) ?? []) assert.ok(p.startsWith("/reach/") || p === "/usr/local/bin/node" || p === "/opt/reach-mcp-client/reach-client.mjs", `${n}: ${p} is outside the approved layout`);
    assert.match(text, installed ? /Restart=on-failure/ : /Restart=always/, installed ? "the Client restarts on failure" : "the DEV Server also restarts itself on a source change");
    assert.match(text, /^User=dev$/m);
  }
  assert.match(units[0]?.text ?? "", /--host 127\.0\.0\.1 --port 8787 --admin-host 127\.0\.0\.1 --admin-port 8788/);
  assert.match(units[1]?.text ?? "", /--allow-insecure-ws/);
});
