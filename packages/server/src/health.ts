// The Server's minimal health snapshot: a plain object read live from the existing owners. It holds no state of its own
// and never includes roots, credentials, digests, config paths, hostnames or request payloads.
import type { ServerConfigStore } from "./config.ts";
import type { ClientConnectionRegistry } from "./connections.ts";

export type HealthDeps = {
  config: ServerConfigStore;
  connections: ClientConnectionRegistry;
  serverBuild: string;
  /** Injected by the runtime owner of build metadata; the Server never reads Git. */
  repositoryCommit?: string;
  uptimeSeconds: () => number;
};

export type HealthSnapshot = {
  status: "ok" | "degraded";
  server_build: string;
  repository_commit: string | null;
  uptime_seconds: number;
  config_active: boolean;
  clients: { connected: number; sessions: { client_id: string; client_build: string; online: boolean; last_seen: number }[] };
  requests: { in_flight: number; completed: number; failed: number; timed_out: number };
};

export function buildHealth({ config, connections, serverBuild, repositoryCommit, uptimeSeconds }: HealthDeps): HealthSnapshot {
  const active = config.isActive();
  const sessions = connections.status().map((s) => ({ client_id: s.client_id, client_build: s.client_build, online: s.online, last_seen: s.last_seen }));
  return {
    status: active ? "ok" : "degraded",
    server_build: serverBuild,
    repository_commit: repositoryCommit ?? null,
    uptime_seconds: Math.floor(uptimeSeconds()),
    config_active: active,
    clients: { connected: sessions.filter((s) => s.online).length, sessions },
    requests: connections.requestCounters(),
  };
}
