import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { buildHealth, createHttpServer, ClientConnectionRegistry, ProposalStore, ServerConfigStore } from "../src/index.ts";
import { CLIENT_MARKER, MCP_MARKER, PHYSICAL_ROOT, startRuntime, until, requestsOf } from "./runtime-fixture.ts";

const getHealth = (port: number, token: string | null = MCP_MARKER) => fetch(`http://127.0.0.1:${port}/health`, { headers: token === null ? {} : { Authorization: `Bearer ${token}` } });

test("active runtime: /health with the bearer returns the minimal snapshot and nothing private", async () => {
  const rt = await startRuntime();
  const client = await rt.connectClient();
  await until(() => client.frames.length === 3, "admitted");
  const res = await getHealth(rt.port);
  assert.equal(res.status, 200);
  const text = await res.text();
  const health = JSON.parse(text);
  assert.deepEqual(Object.keys(health).sort(), ["clients", "config_active", "repository_commit", "requests", "server_build", "status", "uptime_seconds"]);
  assert.equal(health.status, "ok");
  assert.equal(health.server_build, "srv-1");
  assert.equal(health.repository_commit, null);
  assert.equal(health.config_active, true);
  assert.equal(health.clients.connected, 1);
  assert.deepEqual(Object.keys(health.clients.sessions[0]).sort(), ["client_build", "client_id", "enabled", "last_seen", "online"]);
  assert.equal(health.clients.sessions[0].client_id, "laptop");
  assert.equal(health.clients.sessions[0].online, true);
  assert.equal(typeof health.clients.sessions[0].client_build, "string");
  assert.equal(typeof health.clients.sessions[0].last_seen, "number");
  assert.deepEqual(health.clients.sessions[1], { client_id: "idle", enabled: true, online: false, client_build: null, last_seen: null }, "a configured but disconnected Client is listed offline");
  assert.deepEqual(health.requests, { in_flight: 0, completed: 0, failed: 0, timed_out: 0 });
  for (const secret of [PHYSICAL_ROOT, "/srv/", MCP_MARKER, CLIENT_MARKER, "physical_root", "credential", "sha256", "config.json", "127.0.0.1"]) assert.ok(!text.includes(secret), `leaked ${secret}`);
  await rt.close();
});

test("/health uses the same bearer owner: missing or wrong is 401; only GET; other paths stay 404", async () => {
  const rt = await startRuntime();
  assert.equal((await getHealth(rt.port, null)).status, 401);
  assert.equal((await getHealth(rt.port, "wrong")).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${rt.port}/health`, { method: "POST", headers: { Authorization: `Bearer ${MCP_MARKER}` } })).status, 405);
  for (const p of ["/healthz", "/status", "/metrics", "/admin"]) assert.equal((await fetch(`http://127.0.0.1:${rt.port}${p}`, { headers: { Authorization: `Bearer ${MCP_MARKER}` } })).status, 404, p);
  await rt.close();
});

test("inactive config: /health is a controlled 503 with no body, with or without a bearer", async () => {
  const config = new ServerConfigStore("/nonexistent/config.json");
  const connections = new ClientConnectionRegistry({ config, serverBuild: "srv-9", isBuildCompatible: () => true });
  const server = createHttpServer({ config, connections, proposals: new ProposalStore({ path: "/nonexistent/p.json", config, connections }), serverBuild: "srv-9", repositoryCommit: "abc1234", uptimeSeconds: () => 42.9 });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as import("node:net").AddressInfo).port;
  for (const token of [null, MCP_MARKER]) {
    const res = await getHealth(port, token);
    assert.equal(res.status, 503);
    assert.equal(await res.text(), "");
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/nothing`)).status, 404, "the listener keeps serving");
  assert.deepEqual(buildHealth({ config, connections, serverBuild: "srv-9", uptimeSeconds: () => 1 }).clients, { connected: 0, sessions: [] });
  connections.stop();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

test("counters live in the registry and change exactly at request lifecycle boundaries", async () => {
  const rt = await startRuntime();
  const client = await rt.connectClient();
  await until(() => client.frames.length === 3, "admitted");
  const counters = () => rt.connections.requestCounters();
  const ok = rt.connections.route("laptop", "web", { op: "fs_list" }, { requestId: "ok-1" });
  await until(() => requestsOf(client).length === 1, "sent");
  assert.deepEqual(counters(), { in_flight: 1, completed: 0, failed: 0, timed_out: 0 });
  client.ws.send(JSON.stringify({ kind: "response", request_id: "ok-1", ok: true, result: { op: "fs_list", path: "", entries: [], truncated: false } }));
  await ok;
  assert.deepEqual(counters(), { in_flight: 0, completed: 1, failed: 0, timed_out: 0 });
  const bad = rt.connections.route("laptop", "web", { op: "fs_list" }, { requestId: "bad-1" });
  await until(() => requestsOf(client).length === 2, "second sent");
  client.ws.send(JSON.stringify({ kind: "response", request_id: "bad-1", ok: false, error: { code: "DENIED", message: "no" } }));
  await bad;
  assert.deepEqual(counters(), { in_flight: 0, completed: 1, failed: 1, timed_out: 0 });
  await rt.connections.route("laptop", "nope", { op: "fs_list" });
  assert.deepEqual(counters(), { in_flight: 0, completed: 1, failed: 1, timed_out: 0 }, "a refused request was never sent and is not counted");
  const health = JSON.parse(await (await getHealth(rt.port)).text());
  assert.deepEqual(health.requests, { in_flight: 0, completed: 1, failed: 1, timed_out: 0 });
  await rt.close();
});

test("a timed-out request is counted once as timed_out, and its response carries the id that was sent", async () => {
  const rt = await startRuntime({ requestTimeoutMs: 40 });
  const client = await rt.connectClient();
  await until(() => client.frames.length === 3, "admitted");
  const response = await rt.connections.route("laptop", "web", { op: "fs_list" }, { requestId: "slow-1" });
  assert.ok(!response.ok && response.request_id === "slow-1");
  assert.equal(requestsOf(client)[0]!.request_id, "slow-1");
  assert.deepEqual(rt.connections.requestCounters(), { in_flight: 0, completed: 0, failed: 0, timed_out: 1 });
  await rt.close();
});

test("health holds no logger, metrics library, event bus, runtime Git or second id generator", () => {
  const dir = path.join(import.meta.dirname, "..", "src");
  const health = readFileSync(path.join(dir, "health.ts"), "utf8");
  assert.ok(!/child_process|execFile|node:fs|console\.|EventEmitter|prom-client|opentelemetry|randomUUID/.test(health));
  const all = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n");
  assert.equal([...all.matchAll(/randomUUID\(/g)].length, 1, "one request id generator, in the registry");
  assert.ok(!/console\.|EventEmitter|prom-client|opentelemetry|child_process/.test(all));
  assert.ok(typeof buildHealth === "function");
});
