import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { bearerCredential, hashCredential, sameDigest } from "../src/index.ts";
import net from "node:net";
import WebSocket from "ws";
import { ClientConnectionRegistry, createHttpServer, ProposalStore, ServerConfigStore } from "../src/index.ts";
import { CLIENT_MARKER, requestsOf, startRuntime, until, MCP_MARKER } from "./runtime-fixture.ts";

test("auth owner: exactly one Bearer token is read; hashing and digest comparison are stable and constant-time shaped", () => {
  assert.equal(bearerCredential({ authorization: "Bearer abc123" }), "abc123");
  for (const bad of [undefined, "", "Basic abc", "Bearer", "Bearer a b", "bearer abc", "Bearer  abc"]) assert.equal(bearerCredential({ authorization: bad }), null, String(bad));
  assert.equal(bearerCredential({ authorization: ["Bearer a", "Bearer b"] as unknown as string }), null);
  assert.equal(hashCredential("x"), hashCredential("x"));
  assert.match(hashCredential("x"), /^[0-9a-f]{64}$/);
  assert.equal(sameDigest(hashCredential("x"), hashCredential("x")), true);
  assert.equal(sameDigest(hashCredential("x"), hashCredential("y")), false);
  assert.equal(sameDigest("short", hashCredential("x")), false);
});

test("/mcp: missing or wrong bearer is a 401 before the SDK; the right one reaches the SDK", async () => {
  const rt = await startRuntime();
  const init = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } };
  for (const token of [null, "wrong-token", MCP_MARKER + "x"]) {
    const r = await rt.rpc("initialize", init, token);
    assert.equal(r.status, 401, String(token));
    assert.equal(r.headers.get("www-authenticate"), "Bearer");
    assert.equal(r.text, "", "no body, nothing to learn");
  }
  assert.equal((await rt.rpc("initialize", init)).status, 200);
  await rt.close();
});

test("only /mcp and the Client upgrade path exist: every other path is a 404, authenticated or not", async () => {
  const rt = await startRuntime();
  for (const p of ["/", "/healthz", "/admin", "/mcp/extra", "/client", "/ui", "/.well-known/oauth-authorization-server"]) {
    for (const headers of [{}, { Authorization: `Bearer ${MCP_MARKER}` }]) {
      const res = await fetch(`http://127.0.0.1:${rt.port}${p}`, { headers });
      assert.equal(res.status, 404, p);
    }
  }
  await rt.close();
});

test("the Client WebSocket upgrade shares the same listener and still goes through admission", async () => {
  const rt = await startRuntime();
  const wrongPath = await rt.connectClient("/elsewhere");
  assert.equal(await wrongPath.opened, false, "other upgrade paths are refused");
  const client = await rt.connectClient("/client");
  await until(() => client.frames.length === 2, "welcome and policy");
  assert.equal(client.frames[0]!.kind, "welcome");
  assert.equal(client.frames[1]!.kind, "policy_sync");
  assert.equal(rt.connections.status().length, 1);
  assert.equal(requestsOf(client).length, 0);
  await rt.close();
});

test("one owner for each primitive: hashing, digest comparison and bearer parsing live only in auth.ts", () => {
  const dir = path.join(import.meta.dirname, "..", "src");
  const files = readdirSync(dir).map((f) => [f, readFileSync(path.join(dir, f), "utf8")] as const);
  for (const [name, text] of files) {
    if (name === "auth.ts") continue;
    assert.ok(!/createHash|timingSafeEqual|\/\^Bearer/.test(text), `${name} must use the auth owner`);
  }
  assert.equal(files.filter(([, t]) => /export const hashCredential|function bearerCredential|const sameDigest/.test(t)).length, 1);
  const pkg = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")) as { dependencies: Record<string, string> };
  assert.ok(!Object.keys(pkg.dependencies).some((d) => /express|fastify|hono|^@modelcontextprotocol\/sdk$|server-legacy/.test(d)), "no web framework or legacy SDK");
  assert.equal(pkg.dependencies["@modelcontextprotocol/server"], "2.4.0");
  assert.equal(pkg.dependencies["@modelcontextprotocol/node"], "2.1.2");
});

/** Sends raw bytes and returns what the server wrote back, so repeated header lines really hit the Node parser. */
const rawRequest = (port: number, head: string, body = "") =>
  new Promise<string>((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(`${head}Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`));
    let data = "";
    socket.on("data", (d) => (data += d.toString()));
    socket.on("close", () => resolve(data));
  });

test("two real Authorization header lines are refused even when both are the right token", async () => {
  const rt = await startRuntime();
  const head = `POST /mcp HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nAuthorization: Bearer ${MCP_MARKER}\r\nAuthorization: Bearer ${MCP_MARKER}\r\n`;
  const reply = await rawRequest(rt.port, head, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
  assert.match(reply, /^HTTP\/1\.1 401 /);
  assert.ok(!reply.includes("jsonrpc"), "the SDK never answered");
  const single = await rawRequest(rt.port, head.replace(`Authorization: Bearer ${MCP_MARKER}\r\nAuthorization`, "Authorization"), JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
  assert.match(single, /^HTTP\/1\.1 200 /, "a single line still works");
  await rt.close();
});

test("a Client upgrade with two Authorization lines fails admission; a single line is admitted", async () => {
  const rt = await startRuntime();
  const ws = new WebSocket(`ws://127.0.0.1:${rt.port}/client`, { headers: { Authorization: [`Bearer ${CLIENT_MARKER}`, `Bearer ${CLIENT_MARKER}`] as unknown as string } });
  const frames: { kind: string; error?: { code: string } }[] = [];
  ws.on("message", (d) => frames.push(JSON.parse(d.toString())));
  ws.on("error", () => undefined);
  await new Promise<void>((r) => ws.once("open", () => r()));
  ws.send(JSON.stringify({ kind: "hello", client_id: "laptop", credential: CLIENT_MARKER, client_build: "ok-1" }));
  await until(() => frames.length > 0, "an answer");
  assert.equal(frames[0]!.error?.code, "AUTH_FAILED");
  ws.terminate();
  const good = await rt.connectClient();
  await until(() => good.frames.length === 2, "single line admitted");
  await rt.close();
});

test("with no active configuration a well-formed bearer gets a controlled 503, and the listener keeps serving", async () => {
  const config = new ServerConfigStore("/nonexistent/config.json");
  const connections = new ClientConnectionRegistry({ config, serverBuild: "srv-1", isBuildCompatible: () => true });
  const server = createHttpServer({ config, connections, proposals: new ProposalStore({ path: "/nonexistent/p.json", config, connections }), serverBuild: "srv-1" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const withBearer = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { ...headers, Authorization: `Bearer ${MCP_MARKER}` }, body });
  assert.equal(withBearer.status, 503);
  assert.equal(await withBearer.text(), "");
  const without = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers, body });
  assert.equal(without.status, 401, "a missing bearer is still refused as before");
  assert.equal((await fetch(`http://127.0.0.1:${port}/other`)).status, 404, "the listener survived");
  connections.stop();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
