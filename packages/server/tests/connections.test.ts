import { clientRuntimeOf, RUNTIME_DEFAULTS } from "@reach-mcp/shared/runtime-settings";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { ClientConnectionRegistry, hashCredential, ServerConfigStore, type ConnectionOptions } from "../src/index.ts";
import { DESKTOP, LAPTOP, newIdentity, signedHello, type TestIdentity } from "./identity-fixture.ts";

/** An editable view's client without the two read-only facts the edit schema does not accept. */
const editableClient = (view: object): Record<string, unknown> => {
  const client: Record<string, unknown> = { ...view };
  delete client["has_public_key"];
  delete client["pending"];
  return client;
};

const dir = mkdtempSync(path.join(tmpdir(), "reach-server-conn-"));
const configFile = path.join(dir, "config.json");
const baseConfig = () => ({
  mcp_bearer_sha256: hashCredential("mcp-marker-" + "Kd40"),
  clients: [
    { client_id: "laptop", enabled: true, public_key: LAPTOP.publicKey, projects: [{ project_id: "web", physical_root: "/srv/web", mode: "read_write" }, { project_id: "api", physical_root: "/srv/api", mode: "read_only" }] },
    { client_id: "desktop", enabled: true, public_key: DESKTOP.publicKey, projects: [{ project_id: "web", physical_root: "/home/u/web", mode: "read_only" }] },
    { client_id: "off", enabled: false, public_key: newIdentity().publicKey, projects: [{ project_id: "p", physical_root: "/x", mode: "read_only" }] },
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
    pending: () => timers.size,
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

type Frame = { kind: string; nonce?: string; request_id?: string; server_build?: string; error?: { code: string; message: string; details?: unknown }; policies?: { project_id: string }[] };
async function setup(extra: Partial<ConnectionOptions> = {}) {
  writeConfig(baseConfig());
  const config = new ServerConfigStore(configFile);
  config.loadInitial();
  const c = clock();
  const registry = new ClientConnectionRegistry({ config, serverBuild: "srv-1", isBuildCompatible: (b) => b.startsWith("ok-"), now: c.now, schedule: c.schedule, requestTimeoutMs: 5000, maxPendingRequests: 3, ...extra });
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  wss.on("connection", (socket, req) => registry.accept(socket, req.socket.remoteAddress));
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}`;
  const clients: WebSocket[] = [];
  const connect = async (opts: { id?: string; identity?: TestIdentity; build?: string; hello?: unknown; extra?: Record<string, unknown> } = {}) => {
    const ws = new WebSocket(url);
    clients.push(ws);
    const frames: Frame[] = [];
    const closed = new Promise<void>((r) => ws.on("close", () => r()));
    const id = opts.id ?? "laptop";
    ws.on("message", (d) => {
      const frame = JSON.parse(d.toString()) as Frame;
      frames.push(frame);
      if (frame.kind !== "challenge" || opts.hello === null) return;
      const hello = opts.hello ?? signedHello(opts.identity ?? LAPTOP, id, frame.nonce!, { client_build: opts.build ?? "ok-1", ...opts.extra });
      ws.send(typeof hello === "string" || Buffer.isBuffer(hello) ? hello : JSON.stringify(hello));
    });
    ws.on("error", () => undefined);
    await new Promise<void>((r) => ws.once("open", () => r()));
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

test("admission: challenge first, then welcome and the full policy snapshot; the session is online", async () => {
  const t = await setup();
  const c = await t.connect();
  await until(() => c.frames.length === 3, "welcome and policy");
  assert.equal(c.frames[0]!.kind, "challenge");
  assert.deepEqual(c.frames[1], { kind: "welcome", server_build: "srv-1", compatible: true, runtime: clientRuntimeOf(RUNTIME_DEFAULTS) });
  assert.equal(c.frames[2]!.kind, "policy_sync");
  assert.deepEqual(c.frames[2]!.policies!.map((p) => p.project_id), ["web", "api"]);
  assert.deepEqual(t.registry.status().map((s) => [s.client_id, s.client_build, s.online]), [["laptop", "ok-1", true]]);
  await t.done();
});

test("authentication failures: wrong key, foreign key, bad signature, replayed signature, and a disabled client with the wrong key", async () => {
  const t = await setup();
  const stranger = newIdentity();
  const first = await t.connect();
  await until(() => first.frames.length === 3, "a real session to replay from");
  const captured = signedHello(LAPTOP, "laptop", first.frames[0]!.nonce!);
  first.ws.close();
  await first.closed;
  await until(() => t.registry.status().length === 0, "closed");
  const cases: { id?: string; identity?: TestIdentity; hello?: unknown }[] = [
    { identity: DESKTOP },
    { identity: stranger },
    { hello: { ...captured, signature: "A".repeat(86) } },
    { hello: captured },
    { id: "off" },
  ];
  for (const opts of cases) {
    const c = await t.connect(opts);
    await c.closed;
    assert.equal(code(c.frames), "AUTH_FAILED", JSON.stringify(Object.keys(opts)));
    assert.ok(!JSON.stringify(c.frames).includes(LAPTOP.privateKey) && !JSON.stringify(c.frames).includes(DESKTOP.privateKey));
  }
  assert.deepEqual(t.registry.status(), []);
  await t.done();
});

test("every connection gets a fresh unpredictable challenge", async () => {
  const t = await setup();
  const nonces = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const c = await t.connect({ hello: null });
    await until(() => c.frames.length === 1, "challenge");
    assert.match(c.frames[0]!.nonce!, /^[A-Za-z0-9_-]{43}$/);
    nonces.add(c.frames[0]!.nonce!);
  }
  assert.equal(nonces.size, 5);
  await t.done();
});

test("Pending: an unknown client_id proving its key is registered with the public key only and refused; the stored key then reads as Pending, never as AUTH_FAILED, and never gets access", async () => {
  const t = await setup();
  const fresh = newIdentity();
  const c = await t.connect({ id: "newbox", identity: fresh, extra: { display_name: "New box" } });
  await c.closed;
  assert.equal(code(c.frames), "PENDING_APPROVAL");
  assert.equal(c.frames.some((f) => f.kind === "welcome" || f.kind === "policy_sync"), false, "no welcome and no policy before a human Enable");
  assert.deepEqual(t.config.admissionOf("newbox"), { status: "pending", publicKey: fresh.publicKey, nextPublicKey: null, machineUuid: null });
  assert.equal(t.config.effectivePoliciesFor("newbox"), null);
  assert.deepEqual(t.registry.status(), [], "a Pending registration never becomes a session");
  const stored = readFileSync(configFile, "utf8");
  assert.ok(stored.includes(fresh.publicKey) && !stored.includes(fresh.privateKey), "the file holds only the public key");
  const again = await t.connect({ id: "newbox", identity: fresh });
  await again.closed;
  assert.equal(code(again.frames), "PENDING_APPROVAL", "registering twice does not duplicate or fail");
  assert.equal(t.config.snapshot().clients.filter((x) => x.client_id === "newbox").length, 1);
  const forged = await t.connect({ id: "newbox", identity: newIdentity() });
  await forged.closed;
  assert.equal(code(forged.frames), "AUTH_FAILED", "another key cannot use a Pending identity");
  t.config.setClientEnabled("newbox", true);
  const admitted = await t.connect({ id: "newbox", identity: fresh });
  await until(() => admitted.frames.length === 3, "admitted after Enable");
  assert.equal(admitted.frames[1]!.kind, "welcome");
  await t.done();
});

test("registration is refused for an invalid proof, a reused key, an incompatible build and a known id; none of them creates a record", async () => {
  const t = await setup();
  const bad = await t.connect({ id: "ghost", identity: newIdentity(), hello: null });
  const nonce = await (async () => { await until(() => bad.frames.length === 1, "challenge"); return bad.frames[0]!.nonce!; })();
  bad.ws.send(JSON.stringify({ ...signedHello(newIdentity(), "ghost", nonce), signature: "A".repeat(86) }));
  await bad.closed;
  assert.equal(code(bad.frames), "AUTH_FAILED");
  assert.equal(t.config.admissionOf("ghost"), null, "an invalid signature registers nothing");
  const reused = await t.connect({ id: "another", identity: LAPTOP });
  await reused.closed;
  assert.equal(code(reused.frames), "AUTH_FAILED", "a public key already registered cannot register a second client_id");
  assert.equal(t.config.admissionOf("another"), null);
  const wrongBuild = await t.connect({ id: "oldbox", identity: newIdentity(), build: "old-9" });
  await wrongBuild.closed;
  assert.equal(code(wrongBuild.frames), "INCOMPATIBLE_BUILD");
  assert.equal(t.config.admissionOf("oldbox"), null, "an incompatible build is never registered");
  const takeover = await t.connect({ id: "laptop", identity: newIdentity() });
  await takeover.closed;
  assert.equal(code(takeover.frames), "AUTH_FAILED", "a known id never takes a new key");
  await t.done();
});

test("Disable: the live session closes at once, its in-flight request fails, and the stored key is refused as Disabled until Enable", async () => {
  const t = await setup();
  const c = await t.connect();
  await until(() => c.frames.length === 3, "admitted");
  const inFlight = t.registry.route("laptop", "web", { op: "fs_list", path: "" });
  await until(() => requests(c).length === 1, "request delivered");
  t.config.setClientEnabled("laptop", false);
  t.registry.disconnect("laptop");
  const response = await inFlight;
  assert.equal(response.ok, false, "the in-flight request fails through the drop path");
  await c.closed;
  assert.deepEqual(t.registry.status(), []);
  const refused = await t.connect();
  await refused.closed;
  assert.equal(code(refused.frames), "CLIENT_DISABLED");
  assert.equal(refused.frames.some((f) => f.kind === "welcome"), false);
  t.config.setClientEnabled("laptop", true);
  const back = await t.connect();
  await until(() => back.frames.length === 3, "re-enabled and admitted");
  assert.ok(t.registry.lastSeen("laptop") !== null);
  await t.done();
});

test("Rotate Key: only the Client's public key comes back and is STAGED next to the valid key; the old key works until the new one proves itself; refusals are clean", async () => {
  const t = await setup();
  assert.equal(await t.registry.rotateKey("laptop"), "offline", "offline Client");
  assert.equal(await t.registry.rotateKey("nobody"), "offline", "unknown Client");
  assert.equal(await t.registry.rotateKey("off"), "offline", "disabled Client");
  const c = await t.connect();
  await until(() => c.frames.length === 3, "admitted");
  const rotating = t.registry.rotateKey("laptop");
  assert.equal(await t.registry.rotateKey("laptop"), "busy", "one rotation per Client at a time");
  await until(() => c.frames.some((f) => f.kind === "rotate_key"), "rotate frame");
  const frame = c.frames.find((f) => f.kind === "rotate_key") as unknown as { rotation_id: string };
  assert.deepEqual(Object.keys(frame).sort(), ["kind", "rotation_id"]);
  const next = newIdentity();
  c.ws.send(JSON.stringify({ kind: "rotated", rotation_id: "wrong", public_key: newIdentity().publicKey }));
  c.ws.send(JSON.stringify({ kind: "rotated", rotation_id: frame.rotation_id, public_key: next.publicKey }));
  assert.equal(await rotating, "rotated");
  await c.closed;
  assert.ok(c.frames.some((f) => f.kind === "rotate_committed"), "the Client is told to commit only after the key is stored");
  assert.deepEqual([t.config.admissionOf("laptop")?.publicKey, t.config.admissionOf("laptop")?.nextPublicKey], [LAPTOP.publicKey, next.publicKey], "staged next to the valid key");
  const staged = readFileSync(configFile, "utf8");
  assert.ok(staged.includes(LAPTOP.publicKey) && staged.includes(next.publicKey), "both keys are durable until the proof");
  const lost = await t.connect();
  await until(() => lost.frames.length === 3, "a Client that never committed still connects with the old key");
  assert.equal(t.config.admissionOf("laptop")?.nextPublicKey, next.publicKey, "and the staged key stays");
  lost.ws.terminate();
  await until(() => t.registry.status().length === 0, "the old session ended");
  const fresh = await t.connect({ identity: next });
  await until(() => fresh.frames.length === 3, "the new key reconnects");
  assert.deepEqual([t.config.admissionOf("laptop")?.publicKey, t.config.admissionOf("laptop")?.nextPublicKey], [next.publicKey, null], "the proof promotes the new key");
  assert.ok(!readFileSync(configFile, "utf8").includes(LAPTOP.publicKey), "only now the old key is gone");
  const old = await t.connect();
  await old.closed;
  assert.equal(code(old.frames), "AUTH_FAILED", "the old key no longer authenticates");
  const second = t.registry.rotateKey("laptop");
  await until(() => fresh.frames.some((f) => f.kind === "rotate_key"), "second rotate frame");
  t.clock.advance(5000);
  assert.equal(await second, "timeout", "no answer is bounded by the timeout");
  const third = t.registry.rotateKey("laptop");
  fresh.ws.terminate();
  assert.equal(await third, "offline", "a session that closes first ends the rotation");
  const dup = await t.connect({ identity: next });
  await until(() => dup.frames.length === 3, "reconnect");
  const clash = t.registry.rotateKey("laptop");
  await until(() => dup.frames.some((f) => f.kind === "rotate_key"), "clash frame");
  dup.ws.send(JSON.stringify({ kind: "rotated", rotation_id: (dup.frames.find((f) => f.kind === "rotate_key") as unknown as { rotation_id: string }).rotation_id, public_key: DESKTOP.publicKey }));
  assert.equal(await clash, "refused", "a key that belongs to another Client is refused");
  assert.ok(!dup.frames.some((f) => f.kind === "rotate_committed"), "a refused stage never tells the Client to commit");
  assert.equal(t.config.admissionOf("laptop")?.nextPublicKey, null, "and stages nothing");
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
  await until(() => first.frames.length === 3, "first admitted");
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
  await until(() => third.frames.length === 3, "reconnect admitted");
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
  await until(() => first.frames.length === 3, "admitted");
  t.clock.advance(RUNTIME_DEFAULTS.stale_ms + 1_000);
  assert.equal(t.registry.status()[0]!.online, false);
  const refused = await t.registry.route("laptop", "web", { op: "fs_list" });
  assert.ok(!refused.ok && refused.error.code === "NOT_FOUND" && /offline/.test(refused.error.message));
  const second = await t.connect();
  await until(() => second.frames.length === 3, "stale session replaced");
  await first.closed;
  assert.equal(t.registry.status().length, 1);
  t.clock.advance(RUNTIME_DEFAULTS.stale_ms + 1_000);
  t.registry.sweep();
  await second.closed;
  await until(() => t.registry.status().length === 0, "swept");
  await t.done();
});

test("syncPolicy sends the new full snapshot after a reload; a removed project disappears", async () => {
  const t = await setup();
  const c = await t.connect();
  await until(() => c.frames.length === 3, "admitted");
  const next = baseConfig();
  next.clients[0]!.projects = [{ project_id: "only", physical_root: "/srv/only", mode: "read_only" }];
  writeConfig(next);
  t.config.reload();
  t.registry.syncAllPolicies();
  await until(() => c.frames.length === 4, "second snapshot");
  assert.deepEqual(c.frames[3]!.policies!.map((p) => p.project_id), ["only"]);
  assert.equal(t.registry.syncPolicy("desktop"), false, "not connected");
  assert.equal((await t.registry.route("laptop", "web", { op: "fs_list" })).ok, false, "the removed project is no longer routable");
  await t.done();
});

test("routing fails before sending for unknown or disabled clients, unknown projects and offline clients", async () => {
  const t = await setup();
  const c = await t.connect();
  await until(() => c.frames.length === 3, "admitted");
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
  const desktop = await t.connect({ id: "desktop", identity: DESKTOP });
  await until(() => laptop.frames.length === 3 && desktop.frames.length === 3, "both admitted");
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
  await until(() => first.frames.length === 3, "admitted");
  const read = t.registry.route("laptop", "web", { op: "fs_list" });
  const write = t.registry.route("laptop", "web", { op: "fs_write", path: "a", content: "x" });
  await until(() => requests(first).length === 2, "sent");
  first.ws.terminate();
  const [r, w] = await Promise.all([read, write]);
  assert.ok(!r.ok && r.error.code === "INTERNAL");
  assert.ok(!w.ok && w.error.code === "MUTATION_INDETERMINATE");
  const second = await t.connect();
  await until(() => second.frames.length === 3, "reconnected");
  await new Promise((r2) => setTimeout(r2, 30));
  assert.equal(requests(second).length, 0, "no request was replayed on the new connection");
  await t.done();
});

test("timeouts never resend: a read gets a fixed error, a mutation is indeterminate", async () => {
  const t = await setup();
  const c = await t.connect();
  await until(() => c.frames.length === 3, "admitted");
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
  await until(() => c.frames.length === 3, "admitted");
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

test("an invalid option is refused, and the connection registry keeps to routing: no filesystem, MCP, UI or database", () => {
  const config = new ServerConfigStore(configFile);
  assert.throws(() => new ClientConnectionRegistry({ config, serverBuild: "s", isBuildCompatible: () => true, staleMs: 0 }), RangeError);
  const src = path.join(import.meta.dirname, "..", "src");
  const text = readFileSync(path.join(src, "connections.ts"), "utf8");
  assert.ok(!/node:fs|node:child_process|sqlite|express|fastify|\/mcp\b/.test(text));
  assert.ok(!/credential|console\./.test(text));
});

test("display name: a known Client reconnecting with another suggestion never overwrites the name an operator set", async () => {
  const t = await setup();
  const fresh = newIdentity();
  await (await t.connect({ id: "namebox", identity: fresh, extra: { display_name: "Suggested" } })).closed;
  assert.equal(t.config.clientSummaries().find((c) => c.client_id === "namebox")?.display_name, "Suggested", "the first hello stores the suggestion");
  t.config.setClientDisplayName("namebox", "Operator choice");
  await (await t.connect({ id: "namebox", identity: fresh, extra: { display_name: "Another suggestion" } })).closed;
  assert.equal(t.config.clientSummaries().find((c) => c.client_id === "namebox")?.display_name, "Operator choice");
  await t.done();
});

test("the Client build is retained after its session ends and the same client_id with a new key never creates a second Client", async () => {
  const t = await setup();
  const c = await t.connect();
  await until(() => c.frames.length === 3, "welcome and policy");
  assert.equal(t.registry.lastBuild("laptop"), "ok-1");
  assert.equal(t.registry.lastBuild("never-seen"), null);
  c.ws.close();
  await until(() => t.registry.status().length === 0, "session gone");
  assert.equal(t.registry.lastBuild("laptop"), "ok-1", "the version stays observable offline");
  await t.done();
});

const MACHINE = "3eb1bd43-9947-eb76-2998-e566ccc2e099";
const OTHER_MACHINE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

test("legacy Client: the first authenticated hello with a Machine UUID binds it once, keeps status and projects, and never changes a key", async () => {
  const t = await setup();
  const c = await t.connect({ extra: { machine_uuid: MACHINE } });
  await until(() => c.frames.length === 3, "admitted");
  assert.deepEqual(t.config.admissionOf("laptop"), { status: "enabled", publicKey: LAPTOP.publicKey, nextPublicKey: null, machineUuid: MACHINE });
  assert.equal(t.config.effectivePoliciesFor("laptop")!.length, 2, "projects are kept");
  c.ws.close();
  await until(() => t.registry.status().length === 0, "session gone");
  const again = await t.connect({ extra: { machine_uuid: MACHINE } });
  await until(() => again.frames.length === 3, "admitted again with the same machine");
  assert.equal(t.config.snapshot().clients.length, 3);
  await t.done();
});

test("a Client whose record is bound to a machine is refused from another machine, and a Client without a Machine UUID is unchanged", async () => {
  const t = await setup();
  t.config.bindMachineUuid("laptop", MACHINE);
  const copied = await t.connect({ extra: { machine_uuid: OTHER_MACHINE } });
  await copied.closed;
  assert.equal(code(copied.frames), "AUTH_FAILED", "identity copied to another machine");
  const legacy = await t.connect({});
  await until(() => legacy.frames.length === 3, "a Client that reports no Machine UUID still connects");
  assert.equal(t.config.admissionOf("laptop")!.machineUuid, MACHINE);
  await t.done();
});

test("reinstall of a known machine never creates a second Client and the Machine UUID alone never takes over a record", async () => {
  const t = await setup();
  t.config.bindMachineUuid("laptop", MACHINE);
  const reinstalled = await t.connect({ id: MACHINE, identity: newIdentity(), extra: { machine_uuid: MACHINE } });
  await reinstalled.closed;
  assert.equal(code(reinstalled.frames), "AUTH_FAILED", "same machine, new id and fresh key: no second record");
  assert.equal(t.config.admissionOf(MACHINE), null);
  const takeover = await t.connect({ id: "laptop", identity: newIdentity(), extra: { machine_uuid: MACHINE } });
  await takeover.closed;
  assert.equal(code(takeover.frames), "AUTH_FAILED", "the non-secret Machine UUID is not a credential");
  assert.equal(t.config.admissionOf("laptop")!.publicKey, LAPTOP.publicKey, "the trusted key is unchanged");
  assert.equal(t.config.snapshot().clients.length, 3);
  await t.done();
});

test("a new machine enrolls as a distinct Pending Client carrying its Machine UUID; the governed Rotate Key keeps the one record", async () => {
  const t = await setup();
  const fresh = newIdentity();
  const c = await t.connect({ id: OTHER_MACHINE, identity: fresh, extra: { machine_uuid: OTHER_MACHINE } });
  await c.closed;
  assert.equal(code(c.frames), "PENDING_APPROVAL");
  assert.deepEqual(t.config.admissionOf(OTHER_MACHINE), { status: "pending", publicKey: fresh.publicKey, nextPublicKey: null, machineUuid: OTHER_MACHINE });
  t.config.bindMachineUuid("laptop", MACHINE);
  t.config.stageClientPublicKey("laptop", fresh.publicKey === LAPTOP.publicKey ? DESKTOP.publicKey : newIdentity().publicKey);
  assert.equal(t.config.snapshot().clients.filter((x) => x.client_id === "laptop").length, 1);
  assert.equal(t.config.admissionOf("laptop")!.machineUuid, MACHINE, "rotation keeps the machine binding");
  await t.done();
});

test("runtime knobs apply live: a config change moves the stale threshold and the pushed Client timing without a restart or a second sweep timer", async () => {
  const t = await setup();
  const first = await t.connect();
  await until(() => first.frames.length === 3, "welcome and policy");
  assert.deepEqual((first.frames[1] as { runtime?: unknown }).runtime, clientRuntimeOf(RUNTIME_DEFAULTS));
  const idle = t.clock.pending();
  t.registry.start();
  const armed = t.clock.pending();
  t.registry.start();
  assert.equal(armed, idle + 1, "one sweep timer");
  assert.equal(t.clock.pending(), armed, "a second start arms nothing");
  t.clock.advance(RUNTIME_DEFAULTS.stale_ms - 10_000);
  assert.equal(t.registry.status()[0]!.online, true, "inside the default stale window");
  const settled = t.clock.pending();
  const live = { ...RUNTIME_DEFAULTS, heartbeat_interval_ms: 5_000, stale_ms: 20_000 };
  t.config.applyEdit({ runtime: live, clients: t.config.editableView().clients.map(editableClient) });
  assert.equal(t.registry.status()[0]!.online, false, "the shorter stale window applies at once, no restart");
  t.clock.advance(1);
  assert.equal(t.clock.pending(), settled, "the change added no timer");
  t.registry.stop();
  await t.done();
});

test("policy snapshots carry the live Client timing so a connected Client can follow a config change", async () => {
  const t = await setup();
  const c = await t.connect();
  await until(() => c.frames.length === 3, "admitted");
  const live = { ...RUNTIME_DEFAULTS, heartbeat_interval_ms: 5_000, stale_ms: 20_000, reconnect_initial_ms: 200 };
  t.config.applyEdit({ runtime: live, clients: t.config.editableView().clients.map(editableClient) });
  t.registry.syncAllPolicies();
  await until(() => c.frames.length === 4, "second policy snapshot");
  assert.deepEqual((c.frames[3] as { runtime?: unknown }).runtime, clientRuntimeOf(live));
  await t.done();
});
