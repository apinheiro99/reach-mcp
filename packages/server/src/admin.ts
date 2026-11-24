// The Server's admin surface: one static vanilla page and a tiny JSON API, served by the private admin listener (runtime.ts) under
// / and /admin. It holds no state: configuration is read and written only through ServerConfigStore, operational facts come
// from buildHealth, and policies are pushed by the connection registry. The MCP tunnel routes only /mcp, so it never reaches
// these routes. They listen on their own private port (8788), never the service port and never the tunnel.
import type { IncomingMessage, ServerResponse } from "node:http";
import { NO_AUDIT, type Audit } from "./audit.ts";
import { ConfigError, parseClientDisplayNameUpdate } from "./config.ts";
import { NO_LOGGER, type Logger } from "./logging.ts";
import { renderAdminPage } from "./admin-page.ts";
import { LOGO_PNG } from "./admin-ui/assets.ts";
import { createDevReload, DEV_RELOAD_PATH } from "./admin-ui/dev-reload.ts";
import { endpointCatalog } from "./endpoint-catalog.ts";
import { buildHealth, type HealthDeps } from "./health.ts";
import { readLogs } from "./log-reader.ts";
import { systemView } from "./system-info.ts";
import type { ProposalStore } from "./proposals.ts";
import type { SourcePolicy } from "./trusted-network.ts";

const MAX_BODY_BYTES = 1_000_000;
const DECISION_ROUTE = /^\/admin\/api\/proposal\/([^/]+)\/(?:items\/([^/]+)\/)?(approve|reject)$/;
const CLIENT_ROUTE = /^\/admin\/api\/clients\/([^/]+)\/(enable|disable|rotate-key|update)$/;
const DISPLAY_NAME_ROUTE = /^\/admin\/api\/clients\/([^/]+)\/display-name$/;
const ROTATION_HTTP = { rotated: 200, offline: 409, busy: 409, timeout: 504, refused: 422 } as const;
const UPDATE_HTTP = { accepted: 202, offline: 409, busy: 409, unsupported: 422 } as const;
const DECISION_HTTP = { approved: 200, rejected: 200, not_found: 404, stale: 409, invalid: 422 } as const;

export type AdminDeps = Omit<HealthDeps, "uptimeSeconds"> & {
  proposals: ProposalStore;
  uptimeSeconds?: () => number;
  logger?: Logger;
  audit?: Audit;
  /** Direct socket peers allowed to use the admin surface. Omitted means no peer check, which is only safe on a loopback listener. */
  allowFrom?: SourcePolicy;
  /** The operator label of the page header; the page's own default when omitted. */
  adminUser?: string;
  /** The log directory the Logs screen reads (read only) and whose space the System screen shows. */
  logsDir?: string;
  /** The release artifact directory, when one is configured: its presence makes the release routes configured, and its space is shown. */
  artifactsDir?: string;
  /** Which installer scripts the release artifacts can serve; omitted means none. Only the endpoint catalog reads it. */
  installers?: { sh: boolean; ps1: boolean };
  /** DEV only: serve the reload event stream and add its script to the page. */
  devLiveReload?: boolean;
};

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

export function createAdminHandler(deps: AdminDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { config, connections, proposals } = deps;
  const uptimeSeconds = deps.uptimeSeconds ?? process.uptime;
  const logger = deps.logger ?? NO_LOGGER;
  const audit = deps.audit ?? NO_AUDIT;
  const page = renderAdminPage({ devLiveReload: deps.devLiveReload === true, ...(deps.adminUser === undefined ? {} : { adminUser: deps.adminUser }) });
  const devReload = deps.devLiveReload === true ? createDevReload() : undefined;

  /** Runs one config change; on success the Clients get the new policies exactly once, on a refusal nothing changed. Audited once either way. */
  const change = async (res: ServerResponse, action: string, target: string | undefined, apply: () => unknown): Promise<void> => {
    const note = (result: string) => {
      audit.record({ actor: "admin", action, ...(target === undefined ? {} : { target }), result });
      logger.log(result === "ok" ? "RUNNING" : "WARNING", "admin", `${action} ${result}`);
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

  /** Every Client as the Clients screen reads it: config facts and live session facts joined, plus the counts that always add up. */
  const clientsView = () => {
    const sessions = connections.status();
    const clients = config.clientSummaries().map((c) => ({ ...c, online: c.status === "enabled" && sessions.some((s) => s.client_id === c.client_id && s.online), compatible: sessions.find((s) => s.client_id === c.client_id)?.compatible ?? null, update_capable: sessions.find((s) => s.client_id === c.client_id)?.update_capable ?? null, update: sessions.find((s) => s.client_id === c.client_id)?.update ?? null, last_seen: connections.lastSeen(c.client_id), client_build: connections.lastBuild(c.client_id) ?? null }));
    const count = (status: string) => clients.filter((c) => c.status === status).length;
    // Operational state is one partition: a live compatible session is Online, a live incompatible (management-only) one is Incompatible, no live session is Offline.
    const incompatible = clients.filter((c) => c.online && c.compatible === false).length;
    const live = clients.filter((c) => c.online).length;
    return { server_build: deps.serverBuild, clients, counts: { total: clients.length, enabled: count("enabled"), pending: count("pending"), disabled: count("disabled"), online: live - incompatible, incompatible, offline: clients.length - live } };
  };

  return (req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500);
      else res.end();
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (deps.allowFrom && !deps.allowFrom(req.socket.remoteAddress)) return send(res, 403);
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const method = req.method ?? "GET";
    if (pathname === "/") return void res.writeHead(302, { Location: "/admin" }).end();
    if (pathname === "/admin") {
      if (method !== "GET") return send(res, 405);
      return void res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page);
    }
    if (pathname === "/admin/assets/reach-logo.png") {
      if (method !== "GET") return send(res, 405);
      return void res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=3600" }).end(LOGO_PNG);
    }
    if (devReload && pathname === DEV_RELOAD_PATH) return method === "GET" ? devReload(res) : send(res, 405);
    if (pathname === "/admin/api/state") {
      if (method !== "GET") return send(res, 405);
      return send(res, 200, { setup_mode: !config.isActive(), health: buildHealth({ ...deps, uptimeSeconds }), runtime: { admin_autosave_debounce_ms: config.runtimeSettings().admin_autosave_debounce_ms } });
    }
    if (pathname === "/admin/api/system" || pathname === "/admin/api/endpoints" || pathname === "/admin/api/logs") {
      if (method !== "GET") return send(res, 405);
      const health = buildHealth({ ...deps, uptimeSeconds });
      if (pathname === "/admin/api/system") return send(res, 200, systemView(health, [...(deps.logsDir ? [{ name: "Logs", dir: deps.logsDir }] : []), ...(deps.artifactsDir ? [{ name: "Release artifacts", dir: deps.artifactsDir }] : [])]));
      if (pathname === "/admin/api/logs") return send(res, 200, deps.logsDir ? readLogs(deps.logsDir) : { events: [], truncated: false });
      const endpoints = endpointCatalog({ configActive: health.config_active, artifactsConfigured: deps.artifactsDir !== undefined, installers: deps.installers ?? { sh: false, ps1: false } });
      const http = endpoints.filter((e) => e.method !== "WS").length;
      return send(res, 200, { endpoints, counts: { http, websocket: endpoints.length - http, healthy: endpoints.filter((e) => e.status === "healthy").length, errors: endpoints.filter((e) => e.status === "unavailable").length, connected_clients: health.clients.connected }, requests: health.requests });
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
    if (pathname === "/admin/api/clients") {
      if (method !== "GET") return send(res, 405);
      return config.isActive() ? send(res, 200, clientsView()) : send(res, 200, { server_build: deps.serverBuild, clients: [], counts: { total: 0, enabled: 0, pending: 0, disabled: 0, online: 0, incompatible: 0, offline: 0 } });
    }
    const rename = DISPLAY_NAME_ROUTE.exec(pathname);
    if (rename) {
      if (method !== "PUT") return send(res, 405);
      let id: string;
      let displayName: string;
      try {
        id = decodeURIComponent(rename[1] as string);
        displayName = parseClientDisplayNameUpdate(await readJson(req));
      } catch (error) {
        return send(res, 400, { ok: false, problems: error instanceof ConfigError ? error.problems : ["unreadable request"] });
      }
      return change(res, "client_display_name", id, () => config.setClientDisplayName(id, displayName));
    }
    const lifecycle = CLIENT_ROUTE.exec(pathname);
    if (lifecycle) {
      if (method !== "POST") return send(res, 405);
      let id: string;
      try {
        id = decodeURIComponent(lifecycle[1] as string);
      } catch {
        return send(res, 400);
      }
      const action = lifecycle[2];
      if (action === "rotate-key") {
        const result = await connections.rotateKey(id);
        return send(res, ROTATION_HTTP[result], { ok: result === "rotated", result });
      }
      if (action === "update") {
        const result = connections.requestUpdate(id);
        return send(res, UPDATE_HTTP[result], { ok: result === "accepted", result });
      }
      const enable = action === "enable";
      return change(res, `client_${action}`, id, () => {
        config.setClientEnabled(id, enable);
        if (!enable) connections.disconnect(id);
      });
    }
    if (pathname === "/admin/api/proposal") {
      if (method !== "GET") return send(res, 405);
      return send(res, 200, { proposal: proposals.pending(), unusable: proposals.unusable() });
    }
    const decision = DECISION_ROUTE.exec(pathname);
    if (decision) {
      if (method !== "POST") return send(res, 405);
      const id = decodeURIComponent(decision[1] as string);
      const itemId = decision[2] === undefined ? undefined : decodeURIComponent(decision[2]);
      const approve = decision[3] === "approve";
      const result = itemId === undefined ? (approve ? proposals.approve(id) : proposals.reject(id)) : approve ? proposals.approveItem(id, itemId) : proposals.rejectItem(id, itemId);
      return send(res, DECISION_HTTP[result.status], { ok: result.status === "approved" || result.status === "rejected", ...result, config: config.editableView() });
    }
    send(res, 404);
  }
}
