// A real loopback HTTP server wired to a temporary config, a connection registry and fake Clients, for the MCP and HTTP tests.
import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { IDLE, LAPTOP, signedHello } from "./identity-fixture.ts";
import { ClientConnectionRegistry, createHttpServer, hashCredential, ProposalStore, ServerConfigStore, type ConnectionOptions } from "../src/index.ts";

export const MCP_MARKER = "mcp-marker-" + "Kd40";
/** The laptop Client's private key: the secret the tests prove never appears on the Server side. */
export const CLIENT_MARKER = LAPTOP.privateKey;
export const PHYSICAL_ROOT = "/srv/private-web-root";

type Frame = { kind: string; request_id?: string; operation?: { op: string; [k: string]: unknown }; policies?: unknown[] };

export async function startRuntime(extra: Partial<ConnectionOptions> = {}) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "reach-runtime-")), "config.json");
  writeFileSync(
    file,
    JSON.stringify({
      mcp_bearer_sha256: hashCredential(MCP_MARKER),
      clients: [
        { client_id: "laptop", display_name: "Work laptop", enabled: true, public_key: LAPTOP.publicKey, projects: [{ project_id: "web", physical_root: PHYSICAL_ROOT, mode: "read_write" }, { project_id: "api", physical_root: "/srv/api", mode: "read_only" }] },
        { client_id: "idle", enabled: true, public_key: IDLE.publicKey, projects: [{ project_id: "p", physical_root: "/srv/p", mode: "read_only" }] },
      ],
    }),
  );
  const config = new ServerConfigStore(file);
  config.loadInitial();
  const connections = new ClientConnectionRegistry({ config, serverBuild: "srv-1", isBuildCompatible: () => true, ...extra });
  const proposals = new ProposalStore({ path: path.join(path.dirname(file), "proposal.json"), config, connections });
  const server = createHttpServer({ config, connections, proposals, serverBuild: "srv-1" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const sockets: WebSocket[] = [];

  /** Connects a fake Client on the upgrade path, answers the Server's challenge with a signed hello and nothing else. */
  const connectClient = async (clientPath = "/client", id = "laptop", identity = id === "idle" ? IDLE : LAPTOP) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${clientPath}`);
    sockets.push(ws);
    const frames: Frame[] = [];
    ws.on("message", (d) => {
      const frame = JSON.parse(d.toString()) as Frame & { nonce?: string };
      frames.push(frame);
      if (frame.kind === "challenge" && frame.nonce) ws.send(JSON.stringify(signedHello(identity, id, frame.nonce)));
    });
    const opened = new Promise<boolean>((resolve) => {
      ws.once("open", () => resolve(true));
      ws.once("error", () => resolve(false));
      ws.once("unexpected-response", () => resolve(false));
    });
    await opened;
    return { ws, frames, opened: opened };
  };

  /** One JSON-RPC call to /mcp; the reply may be plain JSON or a single SSE event. */
  const rpc = async (method: string, params: unknown, token: string | null = MCP_MARKER, id = 1) => {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    const text = await res.text();
    const json = text.startsWith("{") ? text : text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
    return { status: res.status, headers: res.headers, text, body: json ? JSON.parse(json) : null };
  };

  const close = async () => {
    connections.stop();
    for (const ws of sockets) ws.terminate();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return { port, config, connections, proposals, file, connectClient, rpc, close };
}

export const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error(`timed out: ${what}`);
};
export const requestsOf = (client: { frames: Frame[] }) => client.frames.filter((f) => f.kind === "request");
