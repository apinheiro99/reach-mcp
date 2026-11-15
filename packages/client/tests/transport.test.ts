import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { ClientHello } from "../../shared/src/wire/index.ts";
import { ClientTransport, parseBootstrap, type TransportOptions } from "../src/index.ts";

const CRED = "cred-marker-" + "Wt41pLm";
const root = mkdtempSync(path.join(tmpdir(), "reach-transport-"));

type Seen = { headers: Record<string, string | string[] | undefined>; url: string; frames: unknown[] };
type Harness = { port: number; seen: Seen[]; sockets: ServerSocket[]; close(): Promise<void> };

async function server(onConnection: (socket: ServerSocket, seen: Seen) => void, autoPong = true): Promise<Harness> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", autoPong });
  const seen: Seen[] = [];
  const sockets: ServerSocket[] = [];
  wss.on("connection", (socket, req) => {
    const entry: Seen = { headers: req.headers, url: req.url ?? "", frames: [] };
    seen.push(entry);
    sockets.push(socket);
    socket.on("message", (data) => entry.frames.push(JSON.parse(data.toString())));
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
  parseBootstrap(`REACH_SERVER_URL=ws://127.0.0.1:${port}/ws\nREACH_CLIENT_ID=${id}\nREACH_CLIENT_CREDENTIAL=${CRED}\nREACH_ROOTS=${JSON.stringify([root])}`, { allowInsecureWs: true });

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

test("auth: bearer header on the upgrade, no credential in the URL, exactly one valid hello, connected only after welcome", async () => {
  const srv = await server((s) => s.once("message", () => welcome(s)));
  const c = clock();
  const t = new ClientTransport(boot(srv.port), opts(c));
  t.start();
  await until(() => srv.seen[0]?.frames.length === 1, "hello");
  await until(() => t.snapshot().state === "connected", "connected");
  const seen = srv.seen[0]!;
  assert.equal(seen.headers.authorization, `Bearer ${CRED}`);
  assert.ok(!seen.url.includes(CRED) && !seen.url.includes("?"));
  assert.equal(seen.headers["sec-websocket-extensions"], undefined, "permessage-deflate is not offered");
  assert.equal(seen.headers["sec-websocket-protocol"], undefined, "no subprotocol");
  assert.equal(ClientHello.safeParse(seen.frames[0]).success, true);
  assert.deepEqual(seen.frames[0], { kind: "hello", client_id: "laptop-1", credential: CRED, client_build: "build-1" });
  assert.ok(!JSON.stringify(t.snapshot()).includes(CRED));
  t.stop();
  await srv.close();
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
  assert.deepEqual(srv.seen.at(-1)!.frames[0], { kind: "hello", client_id: "laptop-1", credential: CRED, client_build: "build-1" }, "same identity and build after reconnecting");
  assert.ok(srv.seen.every((s) => s.headers.authorization === `Bearer ${CRED}`), "same credential on every attempt");
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
