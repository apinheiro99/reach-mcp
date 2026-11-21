// The one owner of the pending AI/MCP configuration proposal. At most one proposal exists, kept as one small JSON file:
// its id, time, the redacted editable configuration it was based on, and the secret-free edit. It never holds the active
// configuration, a key or a credential. A proposal activates only when a human approves it, and only through
// ServerConfigStore.applyEdit; if the configuration changed since the proposal was made it is stale and nothing is merged.
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { writeFileAtomic } from "./atomic-file.ts";
import { z } from "zod";
import { ConfigError, EditableView, ProposedEdit, type ServerConfigStore } from "./config.ts";
import { NO_AUDIT, type Audit } from "./audit.ts";
import type { ClientConnectionRegistry } from "./connections.ts";
import { NO_LOGGER, type Logger } from "./logging.ts";

/** The persisted file, strict at every level: an unknown or secret field anywhere makes the whole proposal unusable. */
const StoredProposal = z.strictObject({ proposal_id: z.string().min(1).max(128), created_at: z.iso.datetime(), base: EditableView, edit: ProposedEdit });
type StoredProposal = z.infer<typeof StoredProposal>;
export type DiffEntry = { path: string; before: string | null; after: string | null };
export type ProposalSummary = { proposal_id: string; created_at: string; diff: DiffEntry[] };
export type ProposeResult = { status: "pending"; proposal_id: string } | { status: "already_pending"; proposal_id: string } | { status: "invalid"; problems: readonly string[] };
export type DecisionResult = { status: "approved" | "rejected" | "stale" | "not_found" } | { status: "invalid"; problems: readonly string[] };

export type ProposalDeps = { path: string; config: ServerConfigStore; connections: ClientConnectionRegistry; now?: () => Date; id?: () => string; logger?: Logger; audit?: Audit };

/** Stable text for comparing two views regardless of key order. */
const canon = (value: unknown): string => JSON.stringify(value, (_k, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

/** Every leaf of a view as `path -> JSON`, Clients keyed by client_id and projects by project_id. */
function leaves(view: EditableView["clients"]): Map<string, string> {
  const out = new Map<string, string>();
  for (const { projects, ...client } of view) {
    const at = `clients[${client.client_id}]`;
    out.set(at, "present");
    for (const [key, value] of Object.entries(client)) if (key !== "client_id" && value !== undefined) out.set(`${at}.${key}`, JSON.stringify(value));
    for (const { project_id, ...project } of projects) {
      out.set(`${at}.projects[${project_id}]`, "present");
      for (const [key, value] of Object.entries(project)) if (value !== undefined) out.set(`${at}.projects[${project_id}].${key}`, JSON.stringify(value));
    }
  }
  return out;
}

export class ProposalStore {
  readonly #deps: ProposalDeps;

  constructor(deps: ProposalDeps) {
    this.#deps = deps;
  }

  /** The pending proposal with its deterministic diff, or null when none exists or the file is unusable. */
  pending(): ProposalSummary | null {
    const stored = this.#read();
    return stored && { proposal_id: stored.proposal_id, created_at: stored.created_at, diff: this.#diff(stored) };
  }

  /** Stores an inactive proposal. Nothing about the active configuration, the file or the Clients changes. */
  propose(input: unknown): ProposeResult {
    const existing = this.#read();
    if (existing) return { status: "already_pending", proposal_id: existing.proposal_id };
    let edit: ProposedEdit;
    try {
      edit = this.#deps.config.validateEdit(input);
    } catch (error) {
      if (error instanceof ConfigError) return { status: "invalid", problems: error.problems };
      throw error;
    }
    const proposal_id = (this.#deps.id ?? randomUUID)();
    const stored: StoredProposal = { proposal_id, created_at: (this.#deps.now ?? (() => new Date()))().toISOString(), base: this.#deps.config.editableView(), edit };
    writeFileAtomic(this.#deps.path, `${JSON.stringify(stored, null, 2)}\n`);
    this.#note("ai", "proposal_create", "pending", proposal_id);
    return { status: "pending", proposal_id };
  }

  /** Human approval: stale proposals are refused, anything else activates through the config owner, then Clients get the policies once. */
  approve(proposalId: string): DecisionResult {
    const stored = this.#read();
    if (!stored || stored.proposal_id !== proposalId) return { status: "not_found" };
    const { config, connections } = this.#deps;
    if (canon(config.editableView()) !== canon(stored.base)) {
      this.#note("human", "proposal_approve", "stale", proposalId);
      return { status: "stale" };
    }
    try {
      config.applyEdit(config.validateEdit(stored.edit));
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      this.#note("human", "proposal_approve", "invalid", proposalId);
      return { status: "invalid", problems: error.problems };
    }
    connections.syncAllPolicies();
    this.#remove();
    this.#note("human", "proposal_approve", "approved", proposalId);
    return { status: "approved" };
  }

  /** Human rejection: only the proposal goes away. */
  reject(proposalId: string): DecisionResult {
    const stored = this.#read();
    if (!stored || stored.proposal_id !== proposalId) return { status: "not_found" };
    this.#remove();
    this.#note("human", "proposal_reject", "rejected", proposalId);
    return { status: "rejected" };
  }

  /** One log line and one audit record per proposal event; ids and outcomes only, never the edit. */
  #note(actor: string, action: string, result: string, proposalId: string): void {
    (this.#deps.logger ?? NO_LOGGER).log(result === "stale" || result === "invalid" ? "WARNING" : "INFO", "proposals", `${action} ${result} proposal_id=${proposalId}`);
    (this.#deps.audit ?? NO_AUDIT).record({ actor, action, target: proposalId, result });
  }

  #diff(stored: StoredProposal): DiffEntry[] {
    const before = leaves(stored.base.clients);
    const byId = new Map(stored.base.clients.map((c) => [c.client_id, c.has_public_key]));
    const after = leaves(stored.edit.clients.map((c) => ({ ...c, has_public_key: byId.get(c.client_id) ?? false })));
    return [...new Set([...before.keys(), ...after.keys()])]
      .sort()
      .filter((path) => before.get(path) !== after.get(path))
      .map((path) => ({ path, before: before.get(path) ?? null, after: after.get(path) ?? null }));
  }

  #read(): StoredProposal | null {
    try {
      const parsed = StoredProposal.safeParse(JSON.parse(readFileSync(this.#deps.path, "utf8")));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  #remove(): void {
    rmSync(this.#deps.path, { force: true });
  }
}
