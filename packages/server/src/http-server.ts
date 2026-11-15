// The Server's one HTTP listener: authenticated stateless Streamable HTTP MCP on /mcp and the Client WebSocket upgrade on
// /client. Every other path is a 404; there is no admin UI, health or MCP session here. TLS is the reverse proxy's job.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { WebSocketServer } from "ws";
import { bearerCredential, hashCredential, sameDigest } from "./auth.ts";
import type { ClientConnectionRegistry } from "./connections.ts";
import type { ServerConfigStore } from "./config.ts";
import { buildMcpServer } from "./mcp.ts";

export type HttpServerDeps = { config: ServerConfigStore; connections: ClientConnectionRegistry; serverBuild: string };

const MCP_PATH = "/mcp";
const CLIENT_PATH = "/client";

const pathOf = (req: IncomingMessage): string => new URL(req.url ?? "/", "http://localhost").pathname;

export function createHttpServer(deps: HttpServerDeps): Server {
  const clients = new WebSocketServer({ noServer: true });
  // Repeated Authorization lines are joined into one value, which the auth owner's exact parser then refuses.
  const server = createServer({ joinDuplicateHeaders: true }, (req, res) => {
    if (pathOf(req) !== MCP_PATH) {
      res.writeHead(404).end();
      return;
    }
    const bearer = bearerCredential(req.headers);
    if (bearer === null) {
      res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end();
      return;
    }
    let expected: string;
    try {
      expected = deps.config.mcpBearerDigest();
    } catch {
      res.writeHead(503).end(); // no active configuration: closed, and the SDK is never created
      return;
    }
    if (!sameDigest(hashCredential(bearer), expected)) {
      res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end();
      return;
    }
    const mcp = buildMcpServer(deps);
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => void transport.close().then(() => mcp.close()));
    mcp.connect(transport).then(() => transport.handleRequest(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.on("upgrade", (req, socket, head) => {
    if (pathOf(req) !== CLIENT_PATH) {
      socket.destroy();
      return;
    }
    clients.handleUpgrade(req, socket, head, (ws) => deps.connections.accept(ws, req.headers));
  });
  server.on("close", () => clients.close());
  return server;
}
