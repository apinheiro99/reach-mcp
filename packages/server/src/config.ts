// The Server's runtime configuration: one strict JSON document turned into one in-memory snapshot. A reload builds a
// complete candidate first and swaps it in only when everything validated, so an invalid file never replaces the last
// good configuration. The file format is an implementation detail. Only a SHA-256 digest of each Client credential is
// stored. Physical roots belong to the remote Client host and are never checked against this machine's filesystem.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ClientId, EffectiveProjectPolicy } from "../../shared/src/wire/index.ts";

const ClientEntry = z.strictObject({
  client_id: ClientId,
  display_name: z.string().min(1).max(100).optional(),
  enabled: z.boolean(),
  /** SHA-256 of the Client credential, lowercase hex. Required while the Client is enabled. */
  credential_sha256: z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters").optional(),
  projects: z.array(EffectiveProjectPolicy).max(200),
});

export const ServerConfig = z
  .strictObject({ clients: z.array(ClientEntry).max(500) })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    config.clients.forEach((client, c) => {
      if (seen.has(client.client_id)) ctx.addIssue({ code: "custom", path: ["clients", c, "client_id"], message: "duplicate client_id" });
      seen.add(client.client_id);
      if (client.enabled && !client.credential_sha256) ctx.addIssue({ code: "custom", path: ["clients", c, "credential_sha256"], message: "an enabled client needs a credential digest" });
      const projects = new Set<string>();
      client.projects.forEach((project, p) => {
        if (projects.has(project.project_id)) ctx.addIssue({ code: "custom", path: ["clients", c, "projects", p, "project_id"], message: "duplicate project_id within a client" });
        projects.add(project.project_id);
      });
    });
  });
export type ServerConfig = z.infer<typeof ServerConfig>;

/** What a caller may read of one Client: never the credential digest. */
export type PublicClient = { client_id: string; display_name?: string; enabled: boolean; projects: EffectiveProjectPolicy[] };

/** Problems name a path and a rule, never a value from the file. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: string[]) {
    super(`invalid server config: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

/** Canonical lowercase hex SHA-256 of a presented or enrolled credential. Not reversible; the plaintext is never kept. */
export const hashCredential = (credential: string): string => createHash("sha256").update(credential, "utf8").digest("hex");

function parseConfig(text: string): ServerConfig {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ConfigError(["not valid JSON"]);
  }
  const parsed = ServerConfig.safeParse(json);
  if (parsed.success) return parsed.data;
  throw new ConfigError(parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`));
}

export class ServerConfigStore {
  #active: ServerConfig | null = null;
  readonly #path: string;

  constructor(configPath: string) {
    this.#path = configPath;
  }

  /** First load: there is no last good snapshot, so a failure throws and leaves nothing active. */
  loadInitial(): void {
    this.#active = this.#candidate();
  }

  /** Replaces the whole snapshot or throws and keeps the current one untouched. */
  reload(): void {
    this.#active = this.#candidate();
  }

  isActive(): boolean {
    return this.#active !== null;
  }

  /** A copy of the active configuration without credential digests. */
  snapshot(): { clients: PublicClient[] } {
    const clients = this.#requireActive().clients.map(({ client_id, display_name, enabled, projects }) => ({ client_id, display_name, enabled, projects }));
    return structuredClone({ clients });
  }

  /** The full policy list for an enabled Client, ready for a policy_sync frame; null for an unknown or disabled one. */
  effectivePoliciesFor(clientId: string): EffectiveProjectPolicy[] | null {
    const client = this.#enabledClient(clientId);
    return client ? structuredClone(client.projects) : null;
  }

  /** The stored digest of an enabled Client, for the admission check; null for an unknown or disabled one. */
  credentialDigestFor(clientId: string): string | null {
    return this.#enabledClient(clientId)?.credential_sha256 ?? null;
  }

  #enabledClient(clientId: string) {
    const client = this.#requireActive().clients.find((c) => c.client_id === clientId);
    return client?.enabled ? client : undefined;
  }

  #requireActive(): ServerConfig {
    if (!this.#active) throw new ConfigError(["no configuration is active"]);
    return this.#active;
  }

  #candidate(): ServerConfig {
    let text: string;
    try {
      text = readFileSync(this.#path, "utf8");
    } catch {
      throw new ConfigError(["config file is missing or unreadable"]);
    }
    return parseConfig(text);
  }
}
