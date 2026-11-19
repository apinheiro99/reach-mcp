// The Server's admin surface: a second, separate HTTP listener serving one static vanilla page and a tiny JSON API. It
// holds no state: configuration is read and written only through ServerConfigStore, operational facts come from
// buildHealth, and policies are pushed by the connection registry. It is never a path on the data-plane listener, so it is
// not reachable through the MCP tunnel; it stays private and local by deployment. Release artifacts are served by the separate
// artifact plane (artifact-server.ts), never here.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { NO_AUDIT, type Audit } from "./audit.ts";
import { ConfigError } from "./config.ts";
import { NO_LOGGER, type Logger } from "./logging.ts";
import { ADMIN_PAGE } from "./admin-page.ts";
import { buildHealth, type HealthDeps } from "./health.ts";
import type { ProposalStore } from "./proposals.ts";

const MAX_BODY_BYTES = 1_000_000;
const CREDENTIAL_ROUTE = /^\/admin\/api\/clients\/([^/]+)\/credential$/;
const DECISION_ROUTE = /^\/admin\/api\/proposal\/([^/]+)\/(approve|reject)$/;
const DECISION_HTTP = { approved: 200, rejected: 200, not_found: 404, stale: 409, invalid: 422 } as const;

export type AdminDeps = Omit<HealthDeps, "uptimeSeconds"> & { proposals: ProposalStore; uptimeSeconds?: () => number; logger?: Logger; audit?: Audit };

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
  const logger = deps.logger ?? NO_LOGGER;
  const audit = deps.audit ?? NO_AUDIT;

  /** Runs one config change; on success the Clients get the new policies exactly once, on a refusal nothing changed. Audited once either way. */
  const change = async (res: ServerResponse, action: string, target: string | undefined, apply: () => unknown): Promise<void> => {
    const note = (result: string) => {
      audit.record({ actor: "admin", action, ...(target === undefined ? {} : { target }), result });
      logger.log(result === "ok" ? "INFO" : "WARNING", "admin", `${action} ${result}`);
    };
    try {
      const result = apply();
      connections.syncAllPolicies();
      note("ok");
      send(res, 200, { ok: true, ...(result === undefined ? {} : { result }), config: config.editableView() });
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      note("refused");
      send(res, 422, { ok: false, problems: error.problems });
    }
  };

  // joinDuplicateHeaders: repeated Authorization lines are joined and then refused by the auth owner's exact parser, as on the data plane.
  return createServer({ joinDuplicateHeaders: true }, (req, res) => {
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
      return change(res, "config_edit", undefined, () => config.applyEdit(edit));
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
      const clientId = decodeURIComponent(credential[1] as string);
      return change(res, "credential_issue", clientId, () => ({ credential: config.issueCredential(clientId) }));
    }
    send(res, 404);
  }
}
