// The Server's admin surface: a second, separate HTTP listener serving one static vanilla page and a tiny JSON API. It
// holds no state: configuration is read and written only through ServerConfigStore, operational facts come from
// buildHealth, and policies are pushed by the connection registry. It is never a path on the data-plane listener, so it is
// not reachable through the MCP tunnel; where it is bound and exposed is a deployment decision.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ConfigError } from "./config.ts";
import { ADMIN_PAGE } from "./admin-page.ts";
import { buildHealth, type HealthDeps } from "./health.ts";
import type { ProposalStore } from "./proposals.ts";

const MAX_BODY_BYTES = 1_000_000;
const CREDENTIAL_ROUTE = /^\/admin\/api\/clients\/([^/]+)\/credential$/;
const DECISION_ROUTE = /^\/admin\/api\/proposal\/([^/]+)\/(approve|reject)$/;
const DECISION_HTTP = { approved: 200, rejected: 200, not_found: 404, stale: 409, invalid: 422 } as const;

export type AdminDeps = Omit<HealthDeps, "uptimeSeconds"> & { proposals: ProposalStore; uptimeSeconds?: () => number };

const send = (res: ServerResponse, status: number, body?: unknown): void => {
  if (body === undefined) return void res.writeHead(status).end();
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new ConfigError(["request body is too large"]);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ConfigError(["not valid JSON"]);
  }
}

export function createAdminServer(deps: AdminDeps): Server {
  const { config, connections, proposals } = deps;
  const uptimeSeconds = deps.uptimeSeconds ?? process.uptime;

  /** Runs one config change; on success the Clients get the new policies exactly once, on a refusal nothing changed. */
  const change = async (res: ServerResponse, apply: () => unknown): Promise<void> => {
    try {
      const result = apply();
      connections.syncAllPolicies();
      send(res, 200, { ok: true, ...(result === undefined ? {} : { result }), config: config.editableView() });
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      send(res, 422, { ok: false, problems: error.problems });
    }
  };

  return createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500);
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const method = req.method ?? "GET";
    if (pathname === "/") return void res.writeHead(302, { Location: "/admin" }).end();
    if (pathname === "/admin") {
      if (method !== "GET") return send(res, 405);
      return void res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(ADMIN_PAGE);
    }
    if (pathname === "/admin/api/state") {
      if (method !== "GET") return send(res, 405);
      return send(res, 200, { setup_mode: !config.isActive(), health: buildHealth({ ...deps, uptimeSeconds }) });
    }
    if (pathname === "/admin/api/config") {
      if (method === "GET") return send(res, 200, config.editableView());
      if (method !== "PUT") return send(res, 405);
      let edit: unknown;
      try {
        edit = await readJson(req);
      } catch (error) {
        return send(res, 400, { ok: false, problems: error instanceof ConfigError ? error.problems : ["unreadable request"] });
      }
      return change(res, () => config.applyEdit(edit));
    }
    if (pathname === "/admin/api/proposal") {
      if (method !== "GET") return send(res, 405);
      return send(res, 200, { proposal: proposals.pending() });
    }
    const decision = DECISION_ROUTE.exec(pathname);
    if (decision) {
      if (method !== "POST") return send(res, 405);
      const id = decodeURIComponent(decision[1] as string);
      const result = decision[2] === "approve" ? proposals.approve(id) : proposals.reject(id);
      return send(res, DECISION_HTTP[result.status], { ok: result.status === "approved" || result.status === "rejected", ...result, config: config.editableView() });
    }
    const credential = CREDENTIAL_ROUTE.exec(pathname);
    if (credential) {
      if (method !== "POST") return send(res, 405);
      return change(res, () => ({ credential: config.issueCredential(decodeURIComponent(credential[1] as string)) }));
    }
    send(res, 404);
  }
}
