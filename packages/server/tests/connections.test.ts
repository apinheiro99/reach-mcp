import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { ClientConnectionRegistry, hashCredential, ServerConfigStore, type ConnectionOptions } from "../src/index.ts";

const MARKER = "cred-marker-" + "Lq72Vn";
const OTHER = "cred-marker-" + "Rt19Xe";
const dir = mkdtempSync(path.join(tmpdir(), "reach-server-conn-"));
const configFile = path.join(dir, "config.json");
const baseConfig = () => ({
  clients: [
    { client_id: "laptop", enabled: true, credential_sha256: hashCredential(MARKER), projects: [{ project_id: "web", physical_root: "/srv/web", mode: "read_write" }, { project_id: "api", physical_root: "/srv/api", mode: "read_only" }] },
    { client_id: "desktop", enabled: true, credential_sha256: hashCredential(OTHER), projects: [{ project_id: "web", physical_root: "/home/u/web", mode: "read_only" }] },
    { client_id: "off", enabled: false, credential_sha256: hashCredential(MARKER), projects: [{ project_id: "p", physical_root: "/x", mode: "read_only" }] },
  ],
});
const writeConfig = (config: unknown) => writeFileSync(configFile, JSON.stringify(config));

function clock() {
  let now = 1000;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return () => void timers.delete(id);
    },
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
    },
  };
}

type Frame = { kind: string; request_id?: string; server_build?: string; error?: { code: string; message: string; details?: unknown }; policies?: { project_id: string }[] };
async function setup(extra: Partial<ConnectionOptions> = {}) {
  writeConfig(baseConfig());
  const config = new ServerConfigStore(configFile);
  config.loadInitial();
  const c = clock();
  const registry = new ClientConnectionRegistry({ config, serverBuild: "srv-1", isBuildCompatible: (b) => b.startsWith("ok-"), now: c.now, schedule: c.schedule, requestTimeoutMs: 5000, maxPendingRequests: 3, ...extra });
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  wss.on("connection", (socket, req) => registry.accept(socket, req.headers));
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
  const clients: WebSocket[] = [];
  const connect = async (opts: { bearer?: string | null; id?: string; credential?: string; build?: string; hello?: unknown } = {}) => {
    const bearer = opts.bearer === undefined ? MARKER : opts.bearer;
    const ws = new WebSocket(url, { headers: bearer === null ? {} : { Authorization: bearer.startsWith("Basic") ? bearer : `Bearer ${bearer}` } });
    clients.push(ws);
    const frames: Frame[] = [];
    const closed = new Promise<void>((r) => ws.on("close", () => r()));
    ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
    ws.on("error", () => undefined);
    await new Promise<void>((r) => ws.once("open", () => r()));
    const hello = opts.hello ?? { kind: "hello", client_id: opts.id ?? "laptop", credential: opts.credential ?? MARKER, client_build: opts.build ?? "ok-1" };
    if (hello !== null) ws.send(typeof hello === "string" || Buffer.isBuffer(hello) ? hello : JSON.stringify(hello));
    return { ws, frames, closed };
  };
  const done = async () => {
    registry.stop();
    for (const ws of clients) ws.terminate();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
  };
  return { config, registry, clock: c, connect, done };
}
const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), `timed out: ${what}`);
};
const answer = (client: { ws: WebSocket; frames: Frame[] }, request: { request_id?: string }, extra: object = {}) =>
  client.ws.send(JSON.stringify({ kind: "response", request_id: request.request_id, ok: true, result: { op: "fs_list", path: "", entries: [], truncated: false }, ...extra }));
const requests = (client: { frames: Frame[] }) => client.frames.filter((f) => f.kind === "request");
const code = (frames: Frame[]) => frames.find((f) => f.kind === "reject")?.error?.code;

test("admission: welcome first, then the full policy snapshot; the session is online", async () => {
  const t = await setup();
  const c = await t.connect();
  await until(() => c.frames.length === 2, "welcome and policy");
  assert.deepEqual(c.frames[0], { kind: "welcome", server_build: "srv-1", compatible: true });
  assert.equal(c.frames[1]!.kind, "policy_sync");
  assert.deepEqual(c.frames[1]!.policies!.map((p) => p.project_id), ["web", "api"]);
  assert.deepEqual(t.registry.status().map((s) => [s.client_id, s.client_build, s.online]), [["laptop", "ok-1", true]]);
  await t.done();
});

test("authentication failures: missing/malformed bearer, mismatch, wrong credential, unknown and disabled clients", async () => {
  const t = await setup();
  const cases = [
    { bearer: null },
    { bearer: "Basic abc" },
    { bearer: OTHER },
    { credential: OTHER },
    { bearer: OTHER, credential: OTHER },
    { id: "nobody" },
    { id: "off" },
  ];
  for (const opts of cases) {
    const c = await t.connect(opts);
    await c.closed;
    assert.equal(code(c.frames), "AUTH_FAILED", JSON.stringify(Object.keys(opts)));
    assert.ok(!JSON.stringify(c.frames).includes(MARKER) && !JSON.stringify(c.frames).includes(OTHER));
  }
  assert.deepEqual(t.registry.status(), []);
  await t.done();
});

test("build gate: an incompatible opaque build is refused with both identifiers and no protocol number", async () => {
  const t = await setup();
  const c = await t.connect({ build: "old-9" });
  await c.closed;
  const reject = c.frames.find((f) => f.kind === "reject")!;
  assert.equal(reject.error!.code, "INCOMPATIBLE_BUILD");
  assert.deepEqual(reject.error!.details, { client_build: "old-9", server_build: "srv-1" });
  assert.equal(reject.server_build, "srv-1");
  assert.ok(!/protocol|version/i.test(JSON.stringify(reject)));
  assert.deepEqual(t.registry.status(), []);
  await t.done();
});

test("one active session: a duplicate is refused and the original keeps working; a closed one can reconnect", async () => {
  const t = await setup();
  const first = await t.connect();
  await until(() => first.frames.length === 2, "first admitted");
  const second = await t.connect();
  await second.closed;
  assert.equal(code(second.frames), "DUPLICATE_CLIENT");
  assert.equal(t.registry.status().length, 1);
  const pending = t.registry.route("laptop", "web", { op: "fs_list" });
  await until(() => requests(first).length === 1, "original still receives requests");
  answer(first, requests(first)[0]!);
  assert.equal((await pending).ok, true);
  first.ws.close();
  await first.closed;
  await until(() => t.registry.status().length === 0, "session removed");
  const third = await t.connect();
  await until(() => third.frames.length === 2, "reconnect admitted");
  await t.done();
});

test("a socket that never completes the handshake, or sends garbage first, is not admitted", async () => {
  const t = await setup();
  const silent = await t.connect({ hello: null });
  t.clock.advance(10_001);
  await silent.closed;
  for (const hello of ["{ nope", Buffer.from("binary"), { kind: "request", request_id: "r", project_id: "web", operation: { op: "fs_list" } }]) {
    const c = await t.connect({ hello });
    await c.closed;
    assert.equal(code(c.frames), "BAD_REQUEST");
  }
  assert.deepEqual(t.registry.status(), []);
  await t.done();
});

test("stale sessions go offline, are swept, and are replaced by a fresh connection", async () => {
  const t = await setup();
  const first = await t.connect();
  await until(() => first.frames.length === 2, "admitted");
  t.clock.advance(46_000);
  assert.equal(t.registry.status()[0]!.online, false);
  const refused = await t.registry.route("laptop", "web", { op: "fs_list" });
  assert.ok(!refused.ok && refused.error.code === "NOT_FOUND" && /offline/.test(refused.error.message));
  const second = await t.connect();
  await until(() => second.frames.length === 2, "stale session replaced");
  await first.closed;
  assert.equal(t.registry.status().length, 1);
  t.clock.advance(46_000);
  t.registry.sweep();
  await second.closed;
  await until(() => t.registry.status().length === 0, "swept");
  await t.done();
});

test("syncPolicy sends the new full snapshot after a reload; a removed project disappears", async () => {
  const t = await setup();
  const c = await t.connect();
  await until(() => c.frames.length === 2, "admitted");
  const next = baseConfig();
  next.clients[0]!.projects = [{ project_id: "only", physical_root: "/srv/only", mode: "read_only" }];
  writeConfig(next);
  t.config.reload();
  t.registry.syncAllPolicies();
  await until(() => c.frames.length === 3, "second snapshot");
  assert.deepEqual(c.frames[2]!.policies!.map((p) => p.project_id), ["only"]);
  assert.equal(t.registry.syncPolicy("desktop"), false, "not connected");
  assert.equal((await t.registry.route("laptop", "web", { op: "fs_list" })).ok, false, "the removed project is no longer routable");
  await t.done();
});

test("routing fails before sending for unknown or disabled clients, unknown projects and offline clients", async () => {
  const t = await setup();
  const c = await t.connect();
  await until(() => c.frames.length === 2, "admitted");
  const fail = async (client: string, project: string) => {
    const r = await t.registry.route(client, project, { op: "fs_list" });
    assert.ok(!r.ok);
    return r.error.code + ":" + r.error.message;
  };
  assert.match(await fail("nobody", "web"), /NOT_FOUND:unknown client/);
  assert.match(await fail("off", "p"), /NOT_FOUND:unknown client/);
  assert.match(await fail("laptop", "other"), /NOT_FOUND:unknown project/);
  assert.match(await fail("desktop", "web"), /NOT_FOUND:client is offline/);
  assert.match(await fail("desktop", "api"), /unknown project/, "another client's project name is not valid here");
  assert.equal(requests(c).length, 0, "nothing reached the socket");
  await t.done();
});

test("out-of-order responses settle the right request; foreign, unknown and wrong-session responses settle nothing", async () => {
  const t = await setup();
  const laptop = await t.connect();
  const desktop = await t.connect({ id: "desktop", bearer: OTHER, credential: OTHER });
  await until(() => laptop.frames.length === 2 && desktop.frames.length === 2, "both admitted");
  const a = t.registry.route("laptop", "web", { op: "fs_list" }, { requestId: "A" });
  const b = t.registry.route("laptop", "api", { op: "fs_read", path: "x" }, { requestId: "B" });
  await until(() => requests(laptop).length === 2, "both sent");
  desktop.ws.send(JSON.stringify({ kind: "response", request_id: "A", ok: false, error: { code: "DENIED", message: "forged" } }));
  laptop.ws.send(JSON.stringify({ kind: "response", request_id: "zzz", ok: false, error: { code: "DENIED", message: "unknown" } }));
  await new Promise((r) => setTimeout(r, 30));
  answer(laptop, { request_id: "B" }, { result: { op: "fs_read", path: "x", start_line: 1, end_line: 1, total_lines: 1, truncated: false, next_start_line: null, redactions: 0, content: "1: b" } });
  const rb = await b;
  assert.ok(rb.ok && rb.request_id === "B" && rb.result.op === "fs_read");
  answer(laptop, { request_id: "A" });
  const ra = await a;
  assert.ok(ra.ok && ra.request_id === "A" && ra.result.op === "fs_list", "A was not settled by the forged response");
  await t.done();
});

test("a lost session fails its requests (a mutation as indeterminate) and nothing is replayed after reconnecting", async () => {
  const t = await setup();
  const first = await t.connect();
  await until(() => first.frames.length === 2, "admitted");
  const read = t.registry.route("laptop", "web", { op: "fs_list" });
  const write = t.registry.route("laptop", "web", { op: "fs_write", path: "a", content: "x" });
  await until(() => requests(first).length === 2, "sent");
  first.ws.terminate();
  const [r, w] = await Promise.all([read, write]);
  assert.ok(!r.ok && r.error.code === "INTERNAL");
  assert.ok(!w.ok && w.error.code === "MUTATION_INDETERMINATE");
  const second = await t.connect();
  await until(() => second.frames.length === 2, "reconnected");
  await new Promise((r2) => setTimeout(r2, 30));
  assert.equal(requests(second).length, 0, "no request was replayed on the new connection");
  await t.done();
});

test("timeouts never resend: a read gets a fixed error, a mutation is indeterminate", async () => {
  const t = await setup();
  const c = await t.connect();
  await until(() => c.frames.length === 2, "admitted");
  const read = t.registry.route("laptop", "web", { op: "fs_list" });
  const write = t.registry.route("laptop", "web", { op: "fs_remove", path: "a" });
  await until(() => requests(c).length === 2, "sent");
  t.clock.advance(5_001);
  const [r, w] = await Promise.all([read, write]);
  assert.ok(!r.ok && r.error.code === "INTERNAL" && /timed out/.test(r.error.message));
  assert.ok(!w.ok && w.error.code === "MUTATION_INDETERMINATE");
  await new Promise((r2) => setTimeout(r2, 30));
  assert.equal(requests(c).length, 2, "each request was sent exactly once");
  answer(c, requests(c)[0]!);
  await new Promise((r2) => setTimeout(r2, 30));
  await t.done();
});

test("the pending bound and duplicate in-flight ids are refused deterministically", async () => {
  const t = await setup();
  const c = await t.connect();
  await until(() => c.frames.length === 2, "admitted");
  const held = ["1", "2", "3"].map((id) => t.registry.route("laptop", "web", { op: "fs_list" }, { requestId: id }));
  const over = await t.registry.route("laptop", "web", { op: "fs_list" }, { requestId: "4" });
  assert.ok(!over.ok && /too many pending/.test(over.error.message));
  await until(() => requests(c).length === 3, "three sent");
  for (const r of requests(c)) answer(c, r);
  await Promise.all(held);
  const again = t.registry.route("laptop", "web", { op: "fs_list" }, { requestId: "dup" });
  const dup = await t.registry.route("laptop", "web", { op: "fs_list" }, { requestId: "dup" });
  assert.ok(!dup.ok && dup.error.code === "BAD_REQUEST");
  await until(() => requests(c).length === 4, "first dup sent");
  answer(c, requests(c)[3]!);
  assert.ok((await again).ok);
  await t.done();
});

test("an invalid option is refused, and the server package keeps to routing: no filesystem, MCP, UI or database", () => {
  const config = new ServerConfigStore(configFile);
  assert.throws(() => new ClientConnectionRegistry({ config, serverBuild: "s", isBuildCompatible: () => true, staleMs: 0 }), RangeError);
  const src = path.join(import.meta.dirname, "..", "src");
  const text = readdirSync(src).filter((f) => f !== "config.ts").map((f) => readFileSync(path.join(src, f), "utf8")).join("\n");
  assert.ok(!/node:fs|node:child_process|sqlite|express|fastify|\/mcp\b/.test(text));
  assert.ok(!/credential_sha256|console\./.test(text));
});
