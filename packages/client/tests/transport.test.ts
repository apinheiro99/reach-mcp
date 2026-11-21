import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { generateIdentityKey, newNonce, verifyChallenge } from "@reach-mcp/shared/identity";
import { ClientHello } from "@reach-mcp/shared/wire";
import { ClientDispatcher, ClientTransport, loadBootstrap, parseBootstrap, type FrameHandler, type TransportOptions } from "../src/index.ts";

const KEY = generateIdentityKey();
/** The Client private key: the secret that must never appear in any state, error, URL or frame. */
const CRED = KEY.privateKey;
const root = mkdtempSync(path.join(tmpdir(), "reach-transport-"));

type Seen = { headers: Record<string, string | string[] | undefined>; url: string; frames: unknown[]; nonce: string };
type Harness = { port: number; seen: Seen[]; sockets: ServerSocket[]; close(): Promise<void> };

async function server(onConnection: (socket: ServerSocket, seen: Seen) => void, autoPong = true, challenge = true): Promise<Harness> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", autoPong });
  const seen: Seen[] = [];
  const sockets: ServerSocket[] = [];
  wss.on("connection", (socket, req) => {
    const entry: Seen = { headers: req.headers, url: req.url ?? "", frames: [], nonce: newNonce() };
    seen.push(entry);
    sockets.push(socket);
    socket.on("message", (data) => entry.frames.push(JSON.parse(data.toString())));
    if (challenge) socket.send(JSON.stringify({ kind: "challenge", nonce: entry.nonce }));
    onConnection(socket, entry);
  });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const port = (wss.address() as { port: number }).port;
  return {
    port,
    seen,
    sockets,
    close: () => new Promise<void>((resolve) => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => resolve());
    }),
  };
}

const boot = (port: number, id = "laptop-1") =>
  parseBootstrap(`REACH_SERVER_URL=ws://127.0.0.1:${port}/ws\nREACH_CLIENT_ID=${id}\nREACH_CLIENT_IDENTITY_KEY=${CRED}\nREACH_ROOTS=${JSON.stringify([root])}`, { allowInsecureWs: true });

/** Manual clock and timers so backoff and heartbeat are deterministic. */
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
    pending: () => [...timers.values()].map((t) => t.at - now).sort((a, b) => a - b),
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

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(cond(), `timed out: ${what}`);
};
const welcome = (s: ServerSocket) => s.send(JSON.stringify({ kind: "welcome", server_build: "srv-1", compatible: true }));
const reject = (code: string) => (s: ServerSocket) => s.send(JSON.stringify({ kind: "reject", error: { code, message: "refused" } }));
const opts = (c: ReturnType<typeof clock>, extra: Partial<TransportOptions> = {}): TransportOptions => ({
  build: "build-1", now: c.now, schedule: c.schedule, random: () => 0.5, backoff: { initialMs: 100, maxMs: 400, jitter: 0.2 }, heartbeat: { intervalMs: 50, staleMs: 120 }, ...extra,
});

test("auth: no credential on the upgrade or in the URL, one hello signed over the server's challenge, connected only after welcome", async () => {
  const srv = await server((s) => s.once("message", () => welcome(s)));
  const c = clock();
  const t = new ClientTransport(boot(srv.port), opts(c));
  t.start();
  await until(() => srv.seen[0]?.frames.length === 1, "hello");
  await until(() => t.snapshot().state === "connected", "connected");
  const seen = srv.seen[0]!;
  assert.equal(seen.headers.authorization, undefined, "nothing secret rides on the upgrade");
  assert.ok(!seen.url.includes(CRED) && !seen.url.includes("?"));
  assert.equal(seen.headers["sec-websocket-extensions"], undefined, "permessage-deflate is not offered");
  assert.equal(seen.headers["sec-websocket-protocol"], undefined, "no subprotocol");
  const hello = ClientHello.parse(seen.frames[0]);
  assert.deepEqual([hello.client_id, hello.client_build, hello.public_key], ["laptop-1", "build-1", KEY.publicKey]);
  assert.equal(verifyChallenge(hello.public_key, seen.nonce, "laptop-1", hello.signature), true, "the signature proves possession over this connection's challenge");
  assert.ok(!JSON.stringify(seen.frames).includes(CRED), "the private key never travels");
  assert.ok(!JSON.stringify(t.snapshot()).includes(CRED));
  t.stop();
  await srv.close();
});

test("reconnect answers a new challenge: the earlier signature is not reusable", async () => {
  const srv = await server((s) => s.once("message", () => welcome(s)));
  const c = clock();
  const t = new ClientTransport(boot(srv.port), opts(c));
  t.start();
  await until(() => t.snapshot().state === "connected", "connected");
  srv.sockets[0]!.terminate();
  await until(() => t.snapshot().state === "backoff", "backoff");
  c.advance(100);
  await until(() => srv.seen.length === 2 && t.snapshot().state === "connected", "reconnected");
  const [first, second] = srv.seen.map((x) => ClientHello.parse(x.frames[0]));
  assert.notEqual(srv.seen[0]!.nonce, srv.seen[1]!.nonce);
  assert.notEqual(first!.signature, second!.signature);
  assert.equal(verifyChallenge(second!.public_key, srv.seen[1]!.nonce, "laptop-1", first!.signature), false, "the old signature fails on the new challenge");
  t.stop();
  await srv.close();
});

test("a welcome before the challenge was answered, and a second challenge, close the socket", async () => {
  for (const frames of [[{ kind: "welcome", server_build: "srv-1", compatible: true }], [{ kind: "challenge", nonce: newNonce() }]]) {
    const srv = await server((s) => { for (const f of frames) s.send(JSON.stringify(f)); }, true, frames[0]!.kind === "challenge");
    const t = new ClientTransport(boot(srv.port), opts(clock()));
    t.start();
    await until(() => t.snapshot().state === "backoff", "protocol violation closed the socket");
    assert.equal(t.snapshot().lastError?.code, "BAD_REQUEST");
    t.stop();
    await srv.close();
  }
});

test("open alone is handshaking, not connected", async () => {
  const srv = await server(() => undefined);
  const t = new ClientTransport(boot(srv.port), opts(clock()));
  t.start();
  await until(() => t.snapshot().state === "handshaking", "handshaking");
  assert.equal(srv.seen.length, 1);
  t.stop();
  await srv.close();
});

test("start twice creates one socket; stop cancels timers and prevents reconnect", async () => {
  const srv = await server((s) => s.once("message", () => welcome(s)));
  const c = clock();
  const t = new ClientTransport(boot(srv.port), opts(c));
  t.start();
  t.start();
  await until(() => t.snapshot().state === "connected", "connected");
  assert.equal(srv.seen.length, 1);
  t.stop();
  assert.equal(t.snapshot().state, "stopped");
  assert.deepEqual(c.pending(), []);
  await until(() => srv.sockets[0]!.readyState === 3, "server saw close");
  c.advance(10_000);
  assert.equal(srv.seen.length, 1, "no reconnect after stop");
  await srv.close();
});

for (const code of ["AUTH_FAILED", "DUPLICATE_CLIENT", "INCOMPATIBLE_BUILD"]) {
  test(`${code} reject is terminal: no reconnect, safe error kept`, async () => {
    const srv = await server((s) => s.once("message", () => reject(code)(s)));
    const c = clock();
    const t = new ClientTransport(boot(srv.port), opts(c));
    t.start();
    await until(() => t.snapshot().state === "terminal_error", "terminal");
    assert.equal(t.snapshot().lastError?.code, code);
    assert.deepEqual(c.pending(), [], "no heartbeat or retry timer");
    c.advance(60_000);
    assert.equal(srv.seen.length, 1);
    t.start();
    assert.equal(srv.seen.length, 1, "start does not leave terminal_error");
    t.stop();
    await srv.close();
  });
}

test("malformed and early frames fail closed without echoing the payload, then retry", async () => {
  const leak = "payload-marker-" + "Rk93";
  const srv = await server((s) => s.once("message", () => s.send(`{"kind":"response","note":"${leak}"`)));
  const c = clock();
  const t = new ClientTransport(boot(srv.port), opts(c));
  t.start();
  await until(() => t.snapshot().state === "backoff", "backoff");
  const snap = JSON.stringify(t.snapshot());
  assert.equal(t.snapshot().lastError?.code, "BAD_REQUEST");
  assert.ok(!snap.includes(leak) && !snap.includes(CRED));
  const srv2 = await server((s) => s.once("message", () => s.send(JSON.stringify({ kind: "response", request_id: "r", ok: true, result: {} }))));
  const t2 = new ClientTransport(boot(srv2.port), opts(clock()));
  t2.start();
  await until(() => t2.snapshot().state === "backoff", "response-before-welcome refused");
  assert.equal(t2.snapshot().lastError?.code, "BAD_REQUEST");
  t.stop();
  t2.stop();
  await srv.close();
  await srv2.close();
});

test("a frame after the welcome is refused: request handling belongs to a later task", async () => {
  const srv = await server((s) => s.once("message", () => { welcome(s); s.send(JSON.stringify({ kind: "welcome", server_build: "x", compatible: true })); }));
  const t = new ClientTransport(boot(srv.port), opts(clock()));
  t.start();
  await until(() => t.snapshot().state === "backoff", "backoff after unexpected frame");
  t.stop();
  await srv.close();
});

test("backoff grows to the cap, jitter is injected, and the counter resets only after a welcome", async () => {
  let accept = false;
  const srv = await server((s) => {
    if (accept) s.once("message", () => welcome(s));
    else s.terminate();
  });
  const c = clock();
  const t = new ClientTransport(boot(srv.port), opts(c, { random: () => 0.5 }));
  t.start();
  const delays: number[] = [];
  for (let i = 0; i < 5; i++) {
    await until(() => t.snapshot().state === "backoff" && c.pending().length === 1, `backoff ${i}`);
    const d = c.pending()[0]!;
    delays.push(d);
    c.advance(d);
    await until(() => srv.seen.length === i + 2, `attempt ${i + 2}`);
  }
  assert.deepEqual(delays, [100, 200, 400, 400, 400], "exponential, capped, exactly one timer at a time");
  assert.ok(t.snapshot().attempts >= 5, "an open socket alone did not reset the counter");
  accept = true;
  await until(() => c.pending().length === 1, "next retry");
  c.advance(c.pending()[0]!);
  await until(() => t.snapshot().state === "connected", "connected");
  assert.equal(t.snapshot().attempts, 0);
  const last = ClientHello.parse(srv.seen.at(-1)!.frames[0]);
  assert.deepEqual([last.client_id, last.client_build, last.public_key], ["laptop-1", "build-1", KEY.publicKey], "same identity and build after reconnecting");
  assert.ok(srv.seen.every((s) => s.headers.authorization === undefined), "no credential header on any attempt");
  t.stop();
  await srv.close();
});

test("jitter spreads the delay within its fraction", async () => {
  const delay = async (random: number) => {
    const srv = await server((s) => s.terminate());
    const c = clock();
    const t = new ClientTransport(boot(srv.port), opts(c, { random: () => random }));
    t.start();
    await until(() => c.pending().length === 1, "retry armed");
    const d = c.pending()[0]!;
    t.stop();
    await srv.close();
    return d;
  };
  assert.equal(await delay(0), 80);
  assert.equal(await delay(1), 120);
});

test("a close and an error together schedule one reconnect", async () => {
  const srv = await server((s) => s.terminate());
  const c = clock();
  const t = new ClientTransport(boot(srv.port), opts(c));
  t.start();
  await until(() => t.snapshot().state === "backoff", "backoff");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(c.pending().length, 1);
  t.stop();
  await srv.close();
});

test("heartbeat: pongs keep it healthy; a silent peer is terminated and reconnected exactly once", async () => {
  const healthy = await server((s) => s.once("message", () => welcome(s)));
  const c = clock();
  const t = new ClientTransport(boot(healthy.port), opts(c));
  t.start();
  await until(() => t.snapshot().state === "connected", "connected");
  for (let i = 0; i < 4; i++) {
    const before = t.snapshot().lastHealthyAt;
    c.advance(50);
    await until(() => (t.snapshot().lastHealthyAt ?? 0) > (before ?? 0), "pong recorded");
  }
  assert.equal(t.snapshot().state, "connected");
  t.stop();
  await healthy.close();

  const silent = await server((s) => s.once("message", () => welcome(s)), false);
  const c2 = clock();
  const t2 = new ClientTransport(boot(silent.port), opts(c2));
  t2.start();
  await until(() => t2.snapshot().state === "connected", "connected (silent peer)");
  c2.advance(50);
  c2.advance(50);
  c2.advance(50);
  await until(() => t2.snapshot().state === "backoff", "stale detected");
  assert.equal(t2.snapshot().lastError?.message, "connection stale");
  assert.equal(c2.pending().length, 1, "one retry armed, no heartbeat left");
  t2.stop();
  await silent.close();
});

test("no credential in any recorded error or state, and no inbound listener or server logic in the client source", () => {
  const dir = path.join(import.meta.dirname, "..", "src");
  const source = readdirSync(dir).map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n");
  assert.ok(!/WebSocketServer|\.listen\(|createServer|DUPLICATE_CLIENT.*(close|terminate)/.test(source.replace(/TERMINAL_REJECTS[^;]*;/, "")), "client must hold no server or admission authority");
  assert.ok(!/console\./.test(source), "no logging in the client source");
});

test("handshake deadline: an auto-ponging peer that never answers cannot strand the client; pongs do not extend it", async () => {
  const srv = await server(() => undefined);
  const c = clock();
  const t = new ClientTransport(boot(srv.port), opts(c, { handshakeTimeoutMs: 200, heartbeat: { intervalMs: 50, staleMs: 1000 } }));
  t.start();
  await until(() => t.snapshot().state === "handshaking", "handshaking");
  for (let i = 0; i < 3; i++) {
    const before = t.snapshot().lastHealthyAt;
    c.advance(50);
    await until(() => (t.snapshot().lastHealthyAt ?? 0) > (before ?? 0), "pong while handshaking");
  }
  assert.equal(t.snapshot().state, "handshaking", "still within the deadline");
  c.advance(50);
  await until(() => t.snapshot().state === "backoff", "handshake timed out");
  assert.equal(t.snapshot().lastError?.message, "handshake timed out");
  assert.equal(c.pending().length, 1, "exactly one retry timer; heartbeat and handshake timers are gone");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(c.pending().length, 1, "close after the timeout does not arm a second one");
  t.stop();
  await srv.close();
});

test("handshake deadline is cancelled by welcome, by a terminal reject and by stop", async () => {
  const ok = await server((s) => s.once("message", () => welcome(s)));
  const c1 = clock();
  const t1 = new ClientTransport(boot(ok.port), opts(c1, { handshakeTimeoutMs: 200 }));
  t1.start();
  await until(() => t1.snapshot().state === "connected", "connected");
  assert.deepEqual(c1.pending(), [50], "only the heartbeat remains");
  c1.advance(500);
  assert.equal(t1.snapshot().state, "connected");
  t1.stop();
  await ok.close();

  const bad = await server((s) => s.once("message", () => reject("AUTH_FAILED")(s)));
  const c2 = clock();
  const t2 = new ClientTransport(boot(bad.port), opts(c2, { handshakeTimeoutMs: 200 }));
  t2.start();
  await until(() => t2.snapshot().state === "terminal_error", "terminal");
  assert.deepEqual(c2.pending(), []);
  t2.stop();
  await bad.close();

  const quiet = await server(() => undefined);
  const c3 = clock();
  const t3 = new ClientTransport(boot(quiet.port), opts(c3, { handshakeTimeoutMs: 200 }));
  t3.start();
  await until(() => t3.snapshot().state === "handshaking", "handshaking");
  assert.equal(c3.pending().length, 2, "heartbeat and handshake armed");
  t3.stop();
  assert.deepEqual(c3.pending(), []);
  await quiet.close();
});

test("invalid timing options are rejected deterministically", async () => {
  const b = boot(1);
  const c = clock();
  for (const bad of [
    { handshakeTimeoutMs: 0 },
    { handshakeTimeoutMs: -5 },
    { handshakeTimeoutMs: Number.NaN },
    { backoff: { initialMs: 0, maxMs: 10, jitter: 0 } },
    { backoff: { initialMs: 100, maxMs: 50, jitter: 0 } },
    { backoff: { initialMs: 10, maxMs: 50, jitter: 2 } },
    { heartbeat: { intervalMs: 0, staleMs: 10 } },
    { heartbeat: { intervalMs: 10, staleMs: Infinity } },
  ]) assert.throws(() => new ClientTransport(b, opts(c, bad)), RangeError, JSON.stringify(bad));
  assert.doesNotThrow(() => new ClientTransport(b, { build: "b" }), "defaults are valid");
});

// ---- admitted traffic: policy snapshots, requests and correlated responses --------------------------------------

const readyProject = path.join(root, "proj");
mkdirSync(readyProject, { recursive: true });
writeFileSync(path.join(readyProject, "a.txt"), "alpha\n");
const policyFrame = (...policies: object[]) => ({ kind: "policy_sync", policies });
const goodPolicy = { project_id: "p1", physical_root: readyProject, mode: "read_only" };
const request = (id: string, operation: object, project_id = "p1") => ({ kind: "request", request_id: id, project_id, operation });
const responsesOf = (seen: Seen) => seen.frames.slice(1) as { request_id: string; ok: boolean; result?: { op: string }; error?: { code: string } }[];

/** A server that welcomes and then sends the given frames. */
const welcomingServer = (frames: () => unknown[]) =>
  server((s) => s.once("message", () => { welcome(s); for (const f of frames()) s.send(JSON.stringify(f)); }));

test("admitted: policy_sync then requests execute and each response carries its own request_id and op", async () => {
  const srv = await welcomingServer(() => [policyFrame(goodPolicy), request("a", { op: "fs_list" }), request("b", { op: "fs_read", path: "a.txt" }), request("c", { op: "fs_read", path: "missing.txt" }), request("d", { op: "fs_list" }, "unknown")]);
  const dispatcher = new ClientDispatcher({ anchors: [root] });
  const t = new ClientTransport(boot(srv.port), opts(clock(), { handler: dispatcher }));
  t.start();
  await until(() => srv.seen[0]?.frames.length === 5, "four responses");
  const byId = Object.fromEntries(responsesOf(srv.seen[0]!).map((r) => [r.request_id, r]));
  assert.equal(byId.a?.result?.op, "fs_list");
  assert.equal(byId.b?.result?.op, "fs_read");
  assert.equal(byId.c?.error?.code, "NOT_FOUND");
  assert.equal(byId.d?.error?.code, "NOT_FOUND");
  assert.equal(Object.keys(byId).length, 4, "exactly one response per request");
  t.stop();
  await srv.close();
});

test("admitted: slow and fast requests never cross their responses", async () => {
  const gate = (() => { let release!: () => void; const promise = new Promise<void>((r) => (release = r)); return { promise, release }; })();
  const handler: FrameHandler = {
    applyPolicy: () => undefined,
    handle: async (req) => {
      if (req.request_id === "slow") await gate.promise;
      return { kind: "response", request_id: req.request_id, ok: true, result: { op: "fs_write", path: req.request_id, bytes: 1 } };
    },
  };
  const srv = await welcomingServer(() => [request("slow", { op: "fs_list" }), request("fast", { op: "fs_list" })]);
  const t = new ClientTransport(boot(srv.port), opts(clock(), { handler }));
  t.start();
  await until(() => srv.seen[0]?.frames.length === 2, "fast response first");
  assert.deepEqual(responsesOf(srv.seen[0]!).map((r) => r.request_id), ["fast"]);
  gate.release();
  await until(() => srv.seen[0]?.frames.length === 3, "slow response");
  assert.deepEqual(responsesOf(srv.seen[0]!).map((r) => [r.request_id, (r.result as { path?: string }).path]), [["fast", "fast"], ["slow", "slow"]]);
  t.stop();
  await srv.close();
});

test("admitted: a refused snapshot drops the connection and keeps the last good snapshot; a malformed frame fails closed without echo", async () => {
  const escape = { project_id: "bad", physical_root: path.dirname(root), mode: "read_only" };
  const srv = await welcomingServer(() => [policyFrame(goodPolicy), policyFrame(goodPolicy, escape)]);
  const dispatcher = new ClientDispatcher({ anchors: [root] });
  const t = new ClientTransport(boot(srv.port), opts(clock(), { handler: dispatcher }));
  t.start();
  await until(() => t.snapshot().state === "backoff", "dropped after the refused snapshot");
  assert.equal(t.snapshot().lastError?.message, "policy snapshot refused");
  assert.deepEqual(dispatcher.projects(), ["p1"], "the previous snapshot is untouched");
  t.stop();
  await srv.close();

  const leak = "payload-marker-" + "Hn27";
  const bad = await welcomingServer(() => [{ kind: "request", request_id: leak, project_id: "p1", operation: { op: "shell_exec", cmd: leak } }]);
  const t2 = new ClientTransport(boot(bad.port), opts(clock(), { handler: dispatcher }));
  t2.start();
  await until(() => t2.snapshot().state === "backoff", "malformed frame refused");
  assert.ok(!JSON.stringify(t2.snapshot()).includes(leak) && !JSON.stringify(t2.snapshot()).includes(CRED));
  assert.equal(bad.seen[0]!.frames.length, 1, "no response was sent for it");
  t2.stop();
  await bad.close();
});

test("admitted: a result finishing after the socket was replaced is never sent on the new connection", async () => {
  const gate = (() => { let release!: () => void; const promise = new Promise<void>((r) => (release = r)); return { promise, release }; })();
  let calls = 0;
  const handler: FrameHandler = {
    applyPolicy: () => undefined,
    handle: async (req) => {
      calls++;
      await gate.promise;
      return { kind: "response", request_id: req.request_id, ok: true, result: { op: "fs_write", path: "x", bytes: 1 } };
    },
  };
  let connection = 0;
  const srv = await server((s) => {
    connection++;
    const first = connection === 1;
    s.once("message", () => {
      welcome(s);
      if (first) {
        s.send(JSON.stringify(request("old", { op: "fs_list" })));
        setTimeout(() => s.terminate(), 20);
      }
    });
  });
  const c = clock();
  const t = new ClientTransport(boot(srv.port), opts(c, { handler }));
  t.start();
  await until(() => calls === 1, "request received");
  await until(() => t.snapshot().state === "backoff", "first socket lost");
  c.advance(c.pending()[0]!);
  await until(() => t.snapshot().state === "connected" && srv.seen.length === 2, "reconnected");
  gate.release();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(srv.seen[1]!.frames.length, 1, "only the hello travelled on the new connection");
  assert.equal(calls, 1, "the request was not replayed after reconnecting");
  t.stop();
  await srv.close();
});

test("Pending and Disabled refusals are not terminal: the Client keeps the ordinary backoff and connects once a human enables it, with no manual step", async () => {
  let enabled = false;
  const srv = await server((s) => s.once("message", () => (enabled ? welcome(s) : reject("PENDING_APPROVAL")(s))));
  const c = clock();
  const t = new ClientTransport(boot(srv.port), opts(c));
  t.start();
  await until(() => t.snapshot().state === "backoff", "backoff after Pending");
  assert.equal(t.snapshot().lastError?.code, "PENDING_APPROVAL");
  enabled = true;
  c.advance(c.pending()[0]!);
  await until(() => t.snapshot().state === "connected", "connected after Enable");
  t.stop();
  await srv.close();
  const refused = await server((s) => s.once("message", () => reject("CLIENT_DISABLED")(s)));
  const d = new ClientTransport(boot(refused.port), opts(clock()));
  d.start();
  await until(() => d.snapshot().state === "backoff", "a Disabled Client waits and retries");
  assert.equal(d.snapshot().lastError?.code, "CLIENT_DISABLED");
  d.stop();
  await refused.close();
});

test("rotate_key: the Client answers with only a candidate public key, keeps the valid key until the Server commits, then reconnects proving the new key", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "reach-rotate-")), "bootstrap.env");
  writeFileSync(file, `REACH_SERVER_URL=ws://127.0.0.1:1/ws\nREACH_CLIENT_ID=laptop-1\nREACH_CLIENT_IDENTITY_KEY=${CRED}\nREACH_ROOTS=${JSON.stringify([root])}\n`, { mode: 0o600 });
  let connections = 0;
  let committedAfter = "";
  const srv = await server((s) =>
    s.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { kind: string };
      if (frame.kind === "hello") {
        welcome(s);
        if (connections++ === 0) s.send(JSON.stringify({ kind: "rotate_key", rotation_id: "rot-1" }));
      }
      if (frame.kind === "rotated") committedAfter = readFileSync(file, "utf8");
    }),
  );
  writeFileSync(file, readFileSync(file, "utf8").replace("127.0.0.1:1", `127.0.0.1:${srv.port}`));
  const bootstrap = loadBootstrap(file, { allowInsecureWs: true });
  const c = clock();
  const t = new ClientTransport(bootstrap, opts(c, { handler: new ClientDispatcher({ anchors: [root] }) }));
  t.start();
  await until(() => srv.seen[0]?.frames.length === 2, "the rotated answer");
  const answer = srv.seen[0]!.frames[1] as { kind: string; rotation_id: string; public_key: string };
  assert.deepEqual(Object.keys(answer).sort(), ["kind", "public_key", "rotation_id"], "nothing but the public key travels");
  assert.deepEqual([answer.kind, answer.rotation_id], ["rotated", "rot-1"]);
  assert.notEqual(answer.public_key, KEY.publicKey, "a different pair was generated");
  assert.equal(bootstrap.publicKey(), KEY.publicKey, "the valid key is still the identity until the Server commits");
  assert.ok(committedAfter.includes(CRED), "and the file still holds it");
  srv.sockets[0]!.send(JSON.stringify({ kind: "rotate_committed", rotation_id: "rot-1" }));
  await until(() => bootstrap.publicKey() === answer.public_key, "the Client makes the committed key its own");
  const stored = readFileSync(file, "utf8");
  assert.ok(!JSON.stringify(srv.seen[0]!.frames).includes(/REACH_CLIENT_IDENTITY_KEY=(\S+)/.exec(stored)![1]!), "the new private key never travels");
  assert.ok(!stored.includes(CRED), "the old private key is replaced in the file");
  srv.sockets[0]!.terminate();
  await until(() => t.snapshot().state === "backoff", "retry armed");
  c.advance(c.pending()[0]!);
  await until(() => srv.seen.length === 2, "the Client reconnects");
  const hello = ClientHello.parse(srv.seen[1]!.frames[0]);
  assert.equal(hello.public_key, answer.public_key);
  assert.equal(verifyChallenge(hello.public_key, srv.seen[1]!.nonce, "laptop-1", hello.signature), true, "the reconnect proves the new key");
  t.stop();
  await srv.close();
});

test("rotate_committed for a rotation that was never asked fails closed and keeps the identity", async () => {
  const srv = await server((s) => s.once("message", () => { welcome(s); s.send(JSON.stringify({ kind: "rotate_committed", rotation_id: "rot-0" })); }));
  const bootstrap = boot(srv.port);
  const t = new ClientTransport(bootstrap, opts(clock(), { handler: new ClientDispatcher({ anchors: [root] }) }));
  t.start();
  await until(() => t.snapshot().lastError?.message === "unexpected rotation commit", "commit refused");
  assert.equal(bootstrap.publicKey(), KEY.publicKey);
  t.stop();
  await srv.close();
});

test("rotate_key without a writable bootstrap fails closed without echoing anything and keeps the old identity", async () => {
  const srv = await server((s) => s.once("message", () => { welcome(s); s.send(JSON.stringify({ kind: "rotate_key", rotation_id: "rot-9" })); }));
  const bootstrap = boot(srv.port);
  const t = new ClientTransport(bootstrap, opts(clock(), { handler: new ClientDispatcher({ anchors: [root] }) }));
  t.start();
  await until(() => t.snapshot().lastError?.message === "key rotation failed", "rotation refused");
  assert.equal(bootstrap.publicKey(), KEY.publicKey, "the identity was not replaced");
  assert.ok(!srv.seen[0]!.frames.some((f) => (f as { kind: string }).kind === "rotated"));
  t.stop();
  await srv.close();
});
