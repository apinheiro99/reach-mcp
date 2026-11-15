// The Server's runtime configuration: one strict JSON document turned into one in-memory snapshot. A reload builds a
// complete candidate first and swaps it in only when everything validated, so an invalid file never replaces the last
// good configuration. The file format is an implementation detail. Only a SHA-256 digest of each Client credential is
// stored. Physical roots belong to the remote Client host and are never checked against this machine's filesystem.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic-file.ts";
import { hashCredential } from "./auth.ts";
import { ClientId, EffectiveProjectPolicy } from "../../shared/src/wire/index.ts";

/** SHA-256 of a credential, lowercase hex. */
const Digest = z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters");

const ClientEntry = z.strictObject({
  client_id: ClientId,
  display_name: z.string().min(1).max(100).optional(),
  enabled: z.boolean(),
  /** SHA-256 of the Client credential, lowercase hex. Required while the Client is enabled. */
  credential_sha256: Digest.optional(),
  projects: z.array(EffectiveProjectPolicy).max(200),
});

/** Size and retention of the operational log and the audit trail; their one owner is this config. */
export const LoggingSettings = z.strictObject({ max_bytes: z.int().min(1024).max(1_073_741_824), retention_days: z.int().min(1).max(365) });
export type LoggingSettings = z.infer<typeof LoggingSettings>;
export const DEFAULT_LOGGING: LoggingSettings = { max_bytes: 10 * 1024 * 1024, retention_days: 5 };

export const ServerConfig = z
  .strictObject({
    /** SHA-256 of the bearer token ChatGPT presents to /mcp. */
    mcp_bearer_sha256: Digest,
    clients: z.array(ClientEntry).max(500),
    logging: LoggingSettings.default(DEFAULT_LOGGING),
  })
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

/** What a human edits through the admin UI: the Clients without digests, and a plaintext MCP bearer only when it changes. */
const AdminEdit = z.strictObject({
  mcp_bearer: z.string().min(16).max(256).regex(/^\S+$/, "must not contain whitespace").optional(),
  logging: LoggingSettings.optional(),
  clients: z.array(ClientEntry.omit({ credential_sha256: true })).max(500),
});
/** The shape of editableView(): Clients with their policies and a credential flag, never a digest. Strict, for readers of stored copies. */
export const EditableView = z.strictObject({
  configured: z.boolean(),
  logging: LoggingSettings,
  clients: z.array(ClientEntry.omit({ credential_sha256: true }).extend({ has_credential: z.boolean() })).max(500),
});
export type EditableView = z.infer<typeof EditableView>;

/** What an AI proposal may carry: the human edit without any secret field. */
export const ProposedEdit = AdminEdit.omit({ mcp_bearer: true, logging: true });
export type ProposedEdit = z.infer<typeof ProposedEdit>;

/** What a caller may read of one Client: never the credential digest. */
export type PublicClient = { client_id: string; display_name?: string; enabled: boolean; projects: EffectiveProjectPolicy[] };
/** The editable view of one Client: whether a credential exists, never the credential or its digest. */
export type EditableClient = PublicClient & { has_credential: boolean };

/** Problems name a path and a rule, never a value from the file. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: string[]) {
    super(`invalid server config: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

const problemsOf = (error: z.ZodError): string[] => error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);

function parseConfig(text: string): ServerConfig {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ConfigError(["not valid JSON"]);
  }
  const parsed = ServerConfig.safeParse(json);
  if (parsed.success) return parsed.data;
  throw new ConfigError(problemsOf(parsed.error));
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

  /**
   * The one write path: validates a complete candidate with the schema, persists it atomically (temporary file, fsync,
   * rename) and only then makes it the active snapshot. On any failure the file and the active snapshot are untouched.
   */
  activateCandidate(input: unknown): void {
    const parsed = ServerConfig.safeParse(input);
    if (!parsed.success) throw new ConfigError(problemsOf(parsed.error));
    this.#persist(parsed.data);
    this.#active = parsed.data;
  }

  /** A human edit of the Clients and, optionally, a new MCP bearer: stored digests are carried over by client_id. */
  applyEdit(input: unknown): void {
    const parsed = AdminEdit.safeParse(input);
    if (!parsed.success) throw new ConfigError(problemsOf(parsed.error));
    const mcp = parsed.data.mcp_bearer ? hashCredential(parsed.data.mcp_bearer) : this.#active?.mcp_bearer_sha256;
    if (!mcp) throw new ConfigError(["mcp_bearer: required for the first configuration"]);
    this.activateCandidate(this.#editCandidate(parsed.data.clients, mcp, parsed.data.logging ?? this.#active?.logging));
  }

  /** Dry run of an AI proposal against the active configuration: the normalized secret-free edit, or ConfigError. Nothing changes. */
  validateEdit(input: unknown): ProposedEdit {
    const parsed = ProposedEdit.safeParse(input);
    if (!parsed.success) throw new ConfigError(problemsOf(parsed.error));
    const candidate = ServerConfig.safeParse(this.#editCandidate(parsed.data.clients, this.#requireActive().mcp_bearer_sha256, this.#requireActive().logging));
    if (!candidate.success) throw new ConfigError(problemsOf(candidate.error));
    return parsed.data;
  }

  /** Generates a Client credential, stores only its digest and returns the plaintext, which exists nowhere else. */
  issueCredential(clientId: string): string {
    const active = this.#requireActive();
    if (!active.clients.some((c) => c.client_id === clientId)) throw new ConfigError(["client_id: unknown client"]);
    const credential = randomBytes(32).toString("base64url");
    this.activateCandidate({ ...active, clients: active.clients.map((c) => (c.client_id === clientId ? { ...c, credential_sha256: hashCredential(credential) } : c)) });
    return credential;
  }

  /** What the admin UI edits: every Client with its policies, never a digest. Empty while no configuration is active. */
  editableView(): EditableView {
    if (!this.#active) return { configured: false, logging: { ...DEFAULT_LOGGING }, clients: [] };
    return structuredClone({ configured: true, logging: this.#active.logging, clients: this.#active.clients.map(({ credential_sha256, ...client }) => ({ ...client, has_credential: credential_sha256 !== undefined })) });
  }

  /** The log size and retention in force; the defaults while no configuration is active. */
  loggingSettings(): LoggingSettings {
    return this.#active ? { ...this.#active.logging } : { ...DEFAULT_LOGGING };
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

  /** The digest the MCP endpoint's bearer token must match. */
  mcpBearerDigest(): string {
    return this.#requireActive().mcp_bearer_sha256;
  }

  /** The stored digest of an enabled Client, for the admission check; null for an unknown or disabled one. */
  credentialDigestFor(clientId: string): string | null {
    return this.#enabledClient(clientId)?.credential_sha256 ?? null;
  }

  #editCandidate(clients: ProposedEdit["clients"], mcp_bearer_sha256: string, logging: LoggingSettings | undefined) {
    const digests = new Map((this.#active?.clients ?? []).map((c) => [c.client_id, c.credential_sha256]));
    return { mcp_bearer_sha256, logging, clients: clients.map((c) => ({ ...c, credential_sha256: digests.get(c.client_id) })) };
  }

  #persist(config: ServerConfig): void {
    try {
      writeFileAtomic(this.#path, `${JSON.stringify(config, null, 2)}\n`);
    } catch {
      throw new ConfigError(["could not persist the configuration"]);
    }
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
