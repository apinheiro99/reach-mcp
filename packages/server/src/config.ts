// The Server's runtime configuration: one strict JSON document turned into one in-memory snapshot. A reload builds a
// complete candidate first and swaps it in only when everything validated, so an invalid file never replaces the last
// good configuration. The file format is an implementation detail. Each Client is stored with its Ed25519 PUBLIC key
// only; the private key never reaches the Server. Physical roots belong to the remote Client host and are never checked against this machine's filesystem.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { writeFileAtomic } from "./atomic-file.ts";
import { hashCredential } from "./auth.ts";
import { publicKeyFingerprint } from "@reach-mcp/shared/identity";
import { ClientId, EffectiveProjectPolicy, PublicKey } from "@reach-mcp/shared/wire";

const ClientDisplayNameUpdate = z.strictObject({ display_name: z.string() });

/** The one accepted rename body, exactly `{ display_name: string }`; the length rules belong to the configuration schema. */
export function parseClientDisplayNameUpdate(input: unknown): string {
  const parsed = ClientDisplayNameUpdate.safeParse(input);
  if (!parsed.success) throw new ConfigError(["body must be exactly { display_name: string }"]);
  return parsed.data.display_name;
}

/** SHA-256 of a credential, lowercase hex. */
const Digest = z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters");

const ClientEntry = z.strictObject({
  client_id: ClientId,
  display_name: z.string().min(1).max(100).optional(),
  enabled: z.boolean(),
  /** True from the Client's first valid registration until a human enables or disables it; Pending = enrolled key, never decided. */
  pending: z.literal(true).optional(),
  /** The Client's Ed25519 public key (base64url). Required while the Client is enabled; the private key is never here. */
  public_key: PublicKey.optional(),
  /** A replacement key staged by a Rotate Key: valid next to public_key until the Client proves it, then it becomes public_key. */
  next_public_key: PublicKey.optional(),
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
    const keys = new Set<string>();
    config.clients.forEach((client, c) => {
      if (seen.has(client.client_id)) ctx.addIssue({ code: "custom", path: ["clients", c, "client_id"], message: "duplicate client_id" });
      seen.add(client.client_id);
      if (client.pending && (client.enabled || !client.public_key)) ctx.addIssue({ code: "custom", path: ["clients", c, "pending"], message: "a pending client is not enabled and has a public key" });
      if (client.enabled && !client.public_key) ctx.addIssue({ code: "custom", path: ["clients", c, "public_key"], message: "an enabled client needs a public key" });
      if (client.public_key && keys.has(client.public_key)) ctx.addIssue({ code: "custom", path: ["clients", c, "public_key"], message: "duplicate public key" });
      if (client.public_key) keys.add(client.public_key);
      if (client.next_public_key && (!client.public_key || keys.has(client.next_public_key))) ctx.addIssue({ code: "custom", path: ["clients", c, "next_public_key"], message: "a staged key needs a distinct current key" });
      if (client.next_public_key) keys.add(client.next_public_key);
      const projects = new Set<string>();
      client.projects.forEach((project, p) => {
        if (projects.has(project.project_id)) ctx.addIssue({ code: "custom", path: ["clients", c, "projects", p, "project_id"], message: "duplicate project_id within a client" });
        projects.add(project.project_id);
      });
    });
  });
export type ServerConfig = z.infer<typeof ServerConfig>;

/** What a human edits through the admin UI: the Clients without public keys, and a plaintext MCP bearer only when it changes. */
const AdminEdit = z.strictObject({
  mcp_bearer: z.string().min(16).max(256).regex(/^\S+$/, "must not contain whitespace").optional(),
  logging: LoggingSettings.optional(),
  clients: z.array(ClientEntry.omit({ public_key: true, next_public_key: true, pending: true })).max(500),
});
/** The shape of editableView(): Clients with their policies and an enrollment flag, never the key. Strict, for readers of stored copies. */
export const EditableView = z.strictObject({
  configured: z.boolean(),
  logging: LoggingSettings,
  clients: z.array(ClientEntry.omit({ public_key: true, next_public_key: true }).extend({ has_public_key: z.boolean() })).max(500),
});
export type EditableView = z.infer<typeof EditableView>;

/** What an AI proposal may carry: the human edit without any secret field. */
export const ProposedEdit = AdminEdit.omit({ mcp_bearer: true, logging: true });
export type ProposedEdit = z.infer<typeof ProposedEdit>;

/** What a caller may read of one Client: never its key. */
export type PublicClient = { client_id: string; display_name?: string; enabled: boolean; projects: EffectiveProjectPolicy[] };
/** The one status of a Client: Pending (enrolled, never decided), Enabled or Disabled (a human decision). */
export type ClientStatus = "pending" | "enabled" | "disabled";
/** What the admin Clients screen reads of one Client: identity and authorization, never the key itself. */
export type ClientSummary = { client_id: string; display_name?: string; status: ClientStatus; fingerprint: string | null; projects: number };
/** What admission needs: whether the id is registered, its authorization status and its stored public key, whatever the status. */
export type ClientAdmission = { status: ClientStatus; publicKey: string | null; nextPublicKey: string | null } | null;
/** The editable view of one Client: whether it is enrolled (has a public key), never the key itself. */
export type EditableClient = PublicClient & { has_public_key: boolean };

/** Problems name a path and a rule, never a value from the file. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: string[]) {
    super(`invalid server config: ${problems.join("; ")}`);
    this.problems = problems;
  }
}

const omitPending = (client: ServerConfig["clients"][number]): ServerConfig["clients"][number] => {
  const copy = { ...client };
  delete copy.pending;
  return copy;
};
const statusOf = (client: ServerConfig["clients"][number]): ClientStatus => (client.enabled ? "enabled" : client.pending ? "pending" : "disabled");

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

  /** A human edit of the Clients and, optionally, a new MCP bearer: stored public keys are carried over by client_id. */
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

  /** Registers a previously unknown Client as Pending with its public key, one atomic write; no project and no access until a human enables it. */
  registerPendingClient(clientId: string, publicKey: string, displayName?: string): void {
    const active = this.#requireActive();
    if (active.clients.some((c) => c.client_id === clientId)) throw new ConfigError(["client_id: already registered"]);
    this.activateCandidate({ ...active, clients: [...active.clients, { client_id: clientId, ...(displayName ? { display_name: displayName } : {}), enabled: false, pending: true, public_key: publicKey, projects: [] }] });
  }

  /** The human decision to authorize (true) or refuse (false) a registered Client; its identity, key and projects are kept either way. */
  setClientEnabled(clientId: string, enabled: boolean): void {
    this.#changeClient(clientId, (client) => ({ ...omitPending(client), enabled }));
  }

  /** Durably stages the replacement key a Client generated itself; the current key keeps authenticating next to it. One staged key per Client. */
  stageClientPublicKey(clientId: string, publicKey: string): void {
    this.#changeClient(clientId, (client) => ({ ...client, next_public_key: publicKey }));
  }

  /** The Client proved its staged key: it becomes the key and the old one stops authenticating. */
  promoteClientPublicKey(clientId: string): void {
    this.#changeClient(clientId, ({ next_public_key, ...client }) => ({ ...client, ...(next_public_key ? { public_key: next_public_key } : {}) }));
  }

  /** The human-readable label of a Client; `client_id`, keys, status and projects stay as they are. Blank or over-long names are refused by the schema. */
  setClientDisplayName(clientId: string, displayName: string): void {
    this.#changeClient(clientId, (client) => ({ ...client, display_name: displayName.trim() }));
  }

  /** Every Client as the Clients screen shows it: status and fingerprint, never the key. */
  clientSummaries(): ClientSummary[] {
    return this.#requireActive().clients.map((c) => ({ client_id: c.client_id, ...(c.display_name ? { display_name: c.display_name } : {}), status: statusOf(c), fingerprint: c.public_key ? publicKeyFingerprint(c.public_key) : null, projects: c.projects.length }));
  }

  /** What the admin UI edits: every Client with its policies, never a digest. Empty while no configuration is active. */
  editableView(): EditableView {
    if (!this.#active) return { configured: false, logging: { ...DEFAULT_LOGGING }, clients: [] };
    return structuredClone({ configured: true, logging: this.#active.logging, clients: this.#active.clients.map(({ public_key, ...client }) => { delete client.next_public_key; return { ...client, has_public_key: public_key !== undefined }; }) });
  }

  /** The log size and retention in force; the defaults while no configuration is active. */
  loggingSettings(): LoggingSettings {
    return this.#active ? { ...this.#active.logging } : { ...DEFAULT_LOGGING };
  }

  isActive(): boolean {
    return this.#active !== null;
  }

  /** A copy of the active configuration without public keys. */
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

  /** Admission facts for a client_id: null when unregistered. The key is returned in every status; only an Enabled Client is authorized. */
  admissionOf(clientId: string): ClientAdmission {
    const client = this.#requireActive().clients.find((c) => c.client_id === clientId);
    return client ? { status: statusOf(client), publicKey: client.public_key ?? null, nextPublicKey: client.next_public_key ?? null } : null;
  }

  #editCandidate(clients: ProposedEdit["clients"], mcp_bearer_sha256: string, logging: LoggingSettings | undefined) {
    const keys = new Map((this.#active?.clients ?? []).map((c) => [c.client_id, { public_key: c.public_key, next_public_key: c.next_public_key }]));
    const pending = new Set((this.#active?.clients ?? []).filter((c) => c.pending).map((c) => c.client_id));
    return { mcp_bearer_sha256, logging, clients: clients.map((c) => ({ ...c, ...keys.get(c.client_id), ...(pending.has(c.client_id) && !c.enabled ? { pending: true } : {}) })) };
  }

  #changeClient(clientId: string, change: (client: ServerConfig["clients"][number]) => ServerConfig["clients"][number]): void {
    const active = this.#requireActive();
    if (!active.clients.some((c) => c.client_id === clientId)) throw new ConfigError(["client_id: not registered"]);
    this.activateCandidate({ ...active, clients: active.clients.map((c) => (c.client_id === clientId ? change(c) : c)) });
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
