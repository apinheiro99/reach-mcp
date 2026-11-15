import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startClient } from "../../client/src/runtime.ts";
import { CliError } from "../../shared/src/cli.ts";
import { parseServerArgs, startServer, type RunningServer } from "../src/runtime.ts";

const SRC = path.join(import.meta.dirname, "..", "src");
const ROOT = path.join(import.meta.dirname, "..", "..", "..");
const BEARER = "mcp-bearer-" + "Rk52Yd90";
const SECRET = "secret-" + "arg-Bn18";

const dirs = () => {
  const base = mkdtempSync(path.join(tmpdir(), "reach-runtime-"));
  return { base, config: path.join(base, "private", "config.json"), proposal: path.join(base, "private", "proposal.json"), logs: path.join(base, "logs") };
};
const argv = (d: ReturnType<typeof dirs>, extra: string[] = []) => ["--config", d.config, "--proposal", d.proposal, "--logs", d.logs, "--data-port", "0", "--admin-port", "0", "--build", "dev-1", ...extra];

test("server args: required flags, loopback defaults, valid ports, nothing else accepted and no value echoed", () => {
  const d = dirs();
  const args = parseServerArgs(argv(d));
  assert.deepEqual([args.dataHost, args.adminHost, args.build], ["127.0.0.1", "127.0.0.1", "dev-1"]);
  assert.equal(parseServerArgs(argv(d, ["--repository-commit", "abc"])).repositoryCommit, "abc");
  for (const bad of [[], argv(d).slice(2), [...argv(d), "--config", SECRET], [...argv(d), "--bearer", SECRET], argv(d).map((v) => (v === "0" ? "70000" : v)), [...argv(d), "--data-host"]]) {
    assert.throws(() => parseServerArgs(bad), (e: unknown) => e instanceof CliError && !e.message.includes(SECRET));
  }
});

test("setup mode: with no config the admin works and the data plane fails closed; the first config opens it without a restart", async () => {
  const d = dirs();
  const server = await startServer(parseServerArgs(argv(d)));
  const data = `http://127.0.0.1:${server.dataPort}`;
  const admin = `http://127.0.0.1:${server.adminPort}`;
  assert.equal(((await (await fetch(`${admin}/admin/api/state`)).json()) as { setup_mode: boolean }).setup_mode, true);
  assert.equal((await fetch(`${data}/health`, { headers: { Authorization: `Bearer ${BEARER}` } })).status, 503);
  assert.equal((await fetch(`${data}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${BEARER}` } })).status, 503);
  assert.equal((await fetch(`${admin}/admin/api/config`, { method: "PUT", body: JSON.stringify({ mcp_bearer: BEARER, clients: [] }) })).status, 200);
  const health = await fetch(`${data}/health`, { headers: { Authorization: `Bearer ${BEARER}` } });
  assert.equal(health.status, 200, "usable without a restart");
  assert.equal(((await health.json()) as { server_build: string }).server_build, "dev-1");
  await server.stop();
  await assert.rejects(fetch(`${data}/health`), "the data listener is closed");
  await assert.rejects(fetch(`${admin}/admin/api/state`), "the admin listener is closed");
  const logs = readdirSync(d.logs).map((f) => readFileSync(path.join(d.logs, f), "utf8")).join("\n");
  assert.match(logs, /runtime configuration is not active, setup mode/);
  assert.match(logs, /runtime server started build=dev-1/);
  assert.ok(!logs.includes(BEARER));
});

test("Server and Client runtimes handshake over loopback from temporary private files, with the same build id", async () => {
  const d = dirs();
  const server: RunningServer = await startServer(parseServerArgs(argv(d)));
  const admin = `http://127.0.0.1:${server.adminPort}`;
  const data = `http://127.0.0.1:${server.dataPort}`;
  const root = mkdtempSync(path.join(tmpdir(), "reach-anchor-"));
  const put = (body: unknown) => fetch(`${admin}/admin/api/config`, { method: "PUT", body: JSON.stringify(body) });
  const project = { project_id: "web", physical_root: root, mode: "read_only" };
  assert.equal((await put({ mcp_bearer: BEARER, clients: [{ client_id: "laptop", enabled: false, projects: [project] }] })).status, 200);
  const credential = ((await (await fetch(`${admin}/admin/api/clients/laptop/credential`, { method: "POST" })).json()) as { result: { credential: string } }).result.credential;
  assert.equal((await put({ clients: [{ client_id: "laptop", enabled: true, projects: [project] }] })).status, 200);
  const file = path.join(d.base, "bootstrap.env");
  writeFileSync(file, `REACH_SERVER_URL=ws://127.0.0.1:${server.dataPort}/client\nREACH_CLIENT_ID=laptop\nREACH_CLIENT_CREDENTIAL=${credential}\nREACH_ROOTS=${JSON.stringify([root])}\n`);
  chmodSync(file, 0o600);
  const client = startClient({ bootstrap: file, build: "dev-1", allowInsecureWs: true });
  const connected = async () => ((await (await fetch(`${data}/health`, { headers: { Authorization: `Bearer ${BEARER}` } })).json()) as { clients: { connected: number } }).clients.connected;
  for (let i = 0; i < 100 && (await connected()) !== 1; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await connected(), 1, "the Client was admitted");
  assert.ok(!JSON.stringify(client.transport.snapshot()).includes(credential));
  client.stop();
  await server.stop();
  const logs = readdirSync(d.logs).map((f) => readFileSync(path.join(d.logs, f), "utf8")).join("\n");
  assert.match(logs, /client connected client_id=laptop/);
  assert.ok(![credential, BEARER].some((s) => logs.includes(s)));
});

test("the real Server process starts in setup mode and exits cleanly on SIGTERM", async () => {
  const d = dirs();
  const child = spawn(process.execPath, [path.join(SRC, "main.ts"), ...argv(d)], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c: Buffer) => (out += c.toString()));
  for (let i = 0; i < 100 && !out.includes("listening"); i++) await new Promise((r) => setTimeout(r, 50));
  const ports = /data=(\d+) admin=(\d+)/.exec(out);
  assert.ok(ports, "announced its ports");
  assert.equal(((await (await fetch(`http://127.0.0.1:${ports[2]}/admin/api/state`)).json()) as { setup_mode: boolean }).setup_mode, true);
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  assert.equal(await exited, 0);
  await assert.rejects(fetch(`http://127.0.0.1:${ports[1]}/health`));
});

test("the Server process refuses bad arguments with a usage line and exit code 2, echoing no value", () => {
  const run = spawnSync(process.execPath, [path.join(SRC, "main.ts"), "--config", "a", "--unknown", SECRET], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.ok(run.stderr.includes("usage: server") && !run.stderr.includes(SECRET));
});

test("composition owner audit: each owner is built once, in runtime.ts only", async () => {
  const { readdirSync: ls } = await import("node:fs");
  const files = [...ls(SRC).map((f) => path.join(SRC, f)), ...ls(path.join(ROOT, "packages", "client", "src")).map((f) => path.join(ROOT, "packages", "client", "src", f))];
  const count = (re: RegExp) => files.filter((f) => !f.endsWith("runtime.ts")).filter((f) => re.test(readFileSync(f, "utf8")));
  assert.deepEqual(count(/new ServerConfigStore\(|new ClientConnectionRegistry\(|new ProposalStore\(|new RotatingTextWriter\(|= createHttpServer\(|= createAdminServer\(|new ClientTransport\(|new ClientDispatcher\(/), []);
  const runtime = readFileSync(path.join(SRC, "runtime.ts"), "utf8");
  for (const [name, expected] of [["new ServerConfigStore(", 1], ["new ClientConnectionRegistry(", 1], ["new ProposalStore(", 1], ["new RotatingTextWriter(", 2], ["createHttpServer(common", 1], ["createAdminServer(", 1]] as const) {
    assert.equal(runtime.split(name).length - 1, expected, name);
  }
  assert.ok(!/process\.env|child_process|spawn|setInterval/.test(runtime), "no env contract, subprocess or supervisor loop");
});

test("DEV unit files: only the approved /reach layout, no credential, no obsolete path, no shell", () => {
  const units = ["reach-mcp-server.service", "reach-mcp-client.service"].map((n) => ({ n, text: readFileSync(path.join(ROOT, "deploy", "dev", n), "utf8") }));
  for (const { n, text } of units) {
    const exec = text.split("\n").find((l) => l.startsWith("ExecStart="));
    assert.ok(exec, `${n} has an ExecStart`);
    assert.ok(exec.startsWith("ExecStart=/usr/local/bin/node packages/"), "runs node directly, no shell");
    assert.ok(!/\/etc\/|\/var\/|\/reach\/runtime|reach\.env|client\.env|Environment|sh -c|credential=|token|password|secret/i.test(text.replace(/^#.*$/gm, "")), `${n}: no secret, env or obsolete path`);
    for (const p of exec.match(/(?<=\s)\/[A-Za-z0-9_./-]+/g) ?? []) assert.ok(p.startsWith("/reach/") || p === "/usr/local/bin/node", `${n}: ${p} is outside the approved layout`);
    assert.match(text, /Restart=on-failure/);
    assert.match(text, /^User=dev$/m);
  }
  assert.match(units[0]?.text ?? "", /--data-host 127\.0\.0\.1/);
  assert.match(units[1]?.text ?? "", /--allow-insecure-ws/);
});
