// The one owner of the pending AI/MCP configuration proposal. At most one proposal exists, kept as one small JSON file: its id,
// time, the redacted editable configuration it was based on, and its REVIEW ITEMS. The proposed edit is split into independent items
// (one per Access Rule glob, per project, per Client field), each with a stable id and its own status, so a human approves or rejects
// them one by one; approve-all and reject-all are only conveniences over the same items. It never holds the active configuration, a key
// or a credential. An item activates only when a human approves it, and only through ServerConfigStore.applyEdit; if the configuration
// changed since the proposal (or since its last approved item) was made, the remaining items are stale and nothing is merged.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { writeFileAtomic } from "./atomic-file.ts";
import { z } from "zod";
import { ConfigError, EditableView, ProposedEdit, type ServerConfigStore } from "./config.ts";
import { NO_AUDIT, type Audit } from "./audit.ts";
import type { ClientConnectionRegistry } from "./connections.ts";
import { NO_LOGGER, type Logger } from "./logging.ts";

const RULE_LISTS = ["writable_globs", "deny_globs", "allow_globs"] as const;
type Entry = Record<string, unknown>;

/** One independent change. `value` is the new value of a field, a whole added Client or project; null removes a field. */
const Change = z.strictObject({
  kind: z.enum(["client_add", "client_remove", "client_set", "project_add", "project_remove", "project_set", "rule_add", "rule_remove"]),
  client_id: z.string().min(1).max(128),
  project_id: z.string().min(1).max(128).optional(),
  field: z.string().min(1).max(64).optional(),
  list: z.enum(RULE_LISTS).optional(),
  glob: z.string().min(1).max(512).optional(),
  value: z.unknown().optional(),
});
type Change = z.infer<typeof Change>;
const Item = z.strictObject({ item_id: z.string().min(1).max(64), path: z.string().min(1).max(1024), before: z.string().nullable(), after: z.string().nullable(), status: z.enum(["pending", "approved", "rejected"]), change: Change });
type Item = z.infer<typeof Item>;

/** The persisted file, strict at every level: an unknown or secret field anywhere makes the whole proposal unusable. */
const StoredProposal = z.strictObject({ proposal_id: z.string().min(1).max(128), created_at: z.iso.datetime(), base: EditableView, items: z.array(Item).min(1).max(5000) });
type StoredProposal = z.infer<typeof StoredProposal>;
/** The previous on-disk format: the whole proposed edit next to the base and no items. Read only to migrate it once. */
const LegacyProposal = z.strictObject({ proposal_id: z.string().min(1).max(128), created_at: z.iso.datetime(), base: EditableView, edit: ProposedEdit });
export type DiffEntry = { path: string; before: string | null; after: string | null };
export type ItemSummary = DiffEntry & { item_id: string; status: Item["status"] };
export type ProposalSummary = { proposal_id: string; created_at: string; items: ItemSummary[]; diff: DiffEntry[] };
export type ProposeResult = { status: "pending"; proposal_id: string } | { status: "already_pending"; proposal_id: string } | { status: "invalid"; problems: readonly string[] };
export type DecisionResult = { status: "approved" | "rejected" | "stale" | "not_found"; remaining?: number } | { status: "invalid"; problems: readonly string[] };

export type ProposalDeps = { path: string; config: ServerConfigStore; connections: ClientConnectionRegistry; now?: () => Date; id?: () => string; logger?: Logger; audit?: Audit };

/** Stable text for comparing two views regardless of key order. */
const canon = (value: unknown): string => JSON.stringify(value, (_k, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));
const stripView = ({ has_public_key: _k, pending: _p, ...client }: EditableView["clients"][number]): Entry => client;
const without = (entry: Entry, ...keys: string[]): Entry => Object.fromEntries(Object.entries(entry).filter(([k, v]) => !keys.includes(k) && v !== undefined));
const globsOf = (project: Entry, list: string): string[] => (Array.isArray(project[list]) ? (project[list] as string[]) : []);

/** The id is assigned once, in `itemsOf`, and stored with the item: it never depends on a position that can shift. */
const makeItem = (path: string, before: string | null, after: string | null, change: Change): Item => ({ item_id: "", path, before, after, status: "pending", change });

/** Every scalar field that differs between two records becomes one `set` item (null = the field was removed). */
function fieldItems(at: string, before: Entry, after: Entry, ignore: string[], change: (field: string, value: unknown) => Change): Item[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !ignore.includes(k)).sort();
  return keys.flatMap((field) => (canon(before[field]) === canon(after[field]) ? [] : [makeItem(`${at}.${field}`, before[field] === undefined ? null : canon(before[field]), after[field] === undefined ? null : canon(after[field]), change(field, after[field] ?? null))]));
}

/** The independent review items that turn `base` into `edit`; empty when the edit changes nothing. Deterministic order. */
export function itemsOf(base: EditableView["clients"], edit: ProposedEdit["clients"]): Item[] {
  const before = new Map(base.map((c) => [c.client_id, stripView(c)]));
  const after = new Map(edit.map((c) => [c.client_id, c as Entry]));
  const items: Item[] = [];
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const [b, a] = [before.get(id), after.get(id)];
    const at = `clients[${id}]`;
    if (!b && a) items.push(makeItem(at, null, canon(a), { kind: "client_add", client_id: id, value: a }));
    else if (b && !a) items.push(makeItem(at, "present", null, { kind: "client_remove", client_id: id }));
    else if (b && a) {
      items.push(...fieldItems(at, b, a, ["client_id", "projects"], (field, value) => ({ kind: "client_set", client_id: id, field, value })));
      const [bp, ap] = [new Map((b.projects as Entry[]).map((p) => [p.project_id as string, p])), new Map((a.projects as Entry[]).map((p) => [p.project_id as string, p]))];
      for (const pid of [...new Set([...bp.keys(), ...ap.keys()])].sort()) {
        const [pb, pa] = [bp.get(pid), ap.get(pid)];
        const pat = `${at}.projects[${pid}]`;
        if (!pb && pa) items.push(makeItem(pat, null, canon(pa), { kind: "project_add", client_id: id, project_id: pid, value: pa }));
        else if (pb && !pa) items.push(makeItem(pat, "present", null, { kind: "project_remove", client_id: id, project_id: pid }));
        else if (pb && pa) {
          items.push(...fieldItems(pat, pb, pa, ["project_id", ...RULE_LISTS], (field, value) => ({ kind: "project_set", client_id: id, project_id: pid, field, value })));
          for (const list of RULE_LISTS) {
            const [lb, la] = [globsOf(pb, list), globsOf(pa, list)];
            for (const glob of la.filter((g) => !lb.includes(g))) items.push(makeItem(`${pat}.${list}[${glob}]`, null, "present", { kind: "rule_add", client_id: id, project_id: pid, list, glob }));
            for (const glob of lb.filter((g) => !la.includes(g))) items.push(makeItem(`${pat}.${list}[${glob}]`, "present", null, { kind: "rule_remove", client_id: id, project_id: pid, list, glob }));
          }
        }
      }
    }
  }
  return items.map((item, index) => ({ ...item, item_id: `i${index + 1}` }));
}

const setField = (target: Entry, field: string, value: unknown): void => {
  if (value === null || value === undefined) delete target[field];
  else target[field] = value;
};

/** Applies approved items to the CURRENT view (never to the old edit), so nothing a human changed meanwhile is overwritten. */
function applyItems(current: EditableView["clients"], items: Item[]): ProposedEdit["clients"] {
  const clients = structuredClone(current.map(stripView));
  const clientOf = (id: string) => clients.find((c) => c.client_id === id);
  const projectOf = (c: Entry | undefined, id: string | undefined) => (c?.projects as Entry[] | undefined)?.find((p) => p.project_id === id);
  for (const { change: ch } of items) {
    const client = clientOf(ch.client_id);
    const project = projectOf(client, ch.project_id);
    if (ch.kind === "client_add") clients.push(ch.value as Entry);
    else if (!client) throw new ConfigError([`client_id: ${ch.client_id} is not registered`]);
    else if (ch.kind === "client_remove") clients.splice(clients.indexOf(client), 1);
    else if (ch.kind === "client_set") setField(client, ch.field as string, ch.value);
    else if (ch.kind === "project_add") (client.projects as Entry[]).push(ch.value as Entry);
    else if (!project) throw new ConfigError([`project_id: ${ch.project_id} is not in ${ch.client_id}`]);
    else if (ch.kind === "project_remove") (client.projects as Entry[]).splice((client.projects as Entry[]).indexOf(project), 1);
    else if (ch.kind === "project_set") setField(project, ch.field as string, ch.value);
    else {
      const list = ch.list as string;
      const next = globsOf(project, list).filter((g) => g !== ch.glob);
      if (ch.kind === "rule_add") next.push(ch.glob as string);
      if (next.length) project[list] = next;
      else delete project[list];
    }
  }
  return clients as ProposedEdit["clients"];
}

export class ProposalStore {
  readonly #deps: ProposalDeps;

  constructor(deps: ProposalDeps) {
    this.#deps = deps;
  }

  /** The pending proposal with its review items, or null when none exists or the file is unusable. `diff` lists the still-pending items. */
  pending(): ProposalSummary | null {
    const stored = this.#read();
    if (!stored) return null;
    const items = stored.items.map(({ item_id, path, before, after, status }) => ({ item_id, path, before, after, status }));
    return { proposal_id: stored.proposal_id, created_at: stored.created_at, items, diff: items.filter((i) => i.status === "pending").map(({ path, before, after }) => ({ path, before, after })) };
  }

  /** True when a proposal file exists but cannot be read or migrated: a visible state that keeps the slot closed, never absence. */
  unusable(): boolean {
    return existsSync(this.#deps.path) && this.#read() === null;
  }

  /** Stores an inactive proposal. Nothing about the active configuration, the file or the Clients changes. */
  propose(input: unknown): ProposeResult {
    const existing = this.#read();
    if (existing) return { status: "already_pending", proposal_id: existing.proposal_id };
    if (this.unusable()) return { status: "invalid", problems: ["a stored proposal file exists but cannot be read; it must be resolved by a human before a new proposal"] };
    let edit: ProposedEdit;
    try {
      edit = this.#deps.config.validateEdit(input);
    } catch (error) {
      if (error instanceof ConfigError) return { status: "invalid", problems: error.problems };
      throw error;
    }
    const base = this.#deps.config.editableView();
    const items = itemsOf(base.clients, edit.clients);
    if (items.length === 0) return { status: "invalid", problems: ["the proposal changes nothing"] };
    const proposal_id = (this.#deps.id ?? randomUUID)();
    this.#write({ proposal_id, created_at: (this.#deps.now ?? (() => new Date()))().toISOString(), base, items });
    this.#note("ai", "proposal_create", "pending", proposal_id);
    return { status: "pending", proposal_id };
  }

  /** Human approval of every pending item (the convenience path). */
  approve(proposalId: string): DecisionResult {
    return this.#decide(proposalId, "approve");
  }

  /** Human rejection of every pending item. */
  reject(proposalId: string): DecisionResult {
    return this.#decide(proposalId, "reject");
  }

  /** Human approval of ONE item; the others stay pending and reviewable. */
  approveItem(proposalId: string, itemId: string): DecisionResult {
    return this.#decide(proposalId, "approve", itemId);
  }

  /** Human rejection of ONE item; the others stay pending and reviewable. */
  rejectItem(proposalId: string, itemId: string): DecisionResult {
    return this.#decide(proposalId, "reject", itemId);
  }

  #decide(proposalId: string, decision: "approve" | "reject", itemId?: string): DecisionResult {
    const stored = this.#read();
    if (!stored || stored.proposal_id !== proposalId) return { status: "not_found" };
    const targets = stored.items.filter((i) => i.status === "pending" && (itemId === undefined || i.item_id === itemId));
    if (targets.length === 0) return { status: "not_found" };
    const action = `proposal_${decision}${itemId === undefined ? "" : "_item"}`;
    const target = itemId === undefined ? proposalId : `${proposalId}/${itemId}`;
    const { config, connections } = this.#deps;
    if (decision === "approve") {
      if (canon(config.editableView()) !== canon(stored.base)) {
        this.#note("human", action, "stale", target);
        return { status: "stale" };
      }
      try {
        config.applyEdit(config.validateEdit({ clients: applyItems(config.editableView().clients, targets) }));
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
        this.#note("human", action, "invalid", target);
        return { status: "invalid", problems: error.problems };
      }
      connections.syncAllPolicies();
      stored.base = config.editableView();
    }
    for (const item of targets) item.status = decision === "approve" ? "approved" : "rejected";
    const remaining = stored.items.filter((i) => i.status === "pending").length;
    if (remaining === 0) this.#remove();
    else this.#write(stored);
    this.#note("human", action, decision === "approve" ? "approved" : "rejected", target);
    return { status: decision === "approve" ? "approved" : "rejected", remaining };
  }

  /** One log line and one audit record per proposal event; ids and outcomes only, never the edit. */
  #note(actor: string, action: string, result: string, proposalId: string): void {
    (this.#deps.logger ?? NO_LOGGER).log(result === "stale" || result === "invalid" ? "WARNING" : "INFO", "proposals", `${action} ${result} proposal_id=${proposalId}`);
    (this.#deps.audit ?? NO_AUDIT).record({ actor, action, target: proposalId, result });
  }

  /** The stored proposal; a valid previous-format file is migrated first (same id, time and base, items derived, nothing applied). */
  #read(): StoredProposal | null {
    try {
      const raw: unknown = JSON.parse(readFileSync(this.#deps.path, "utf8"));
      const current = StoredProposal.safeParse(raw);
      if (current.success) return current.data;
      const legacy = LegacyProposal.safeParse(raw);
      if (!legacy.success) return null;
      const { proposal_id, created_at, base, edit } = legacy.data;
      const items = itemsOf(base.clients, edit.clients);
      if (items.length === 0) return null;
      const migrated = StoredProposal.parse({ proposal_id, created_at, base, items });
      this.#write(migrated);
      return migrated;
    } catch {
      return null;
    }
  }

  #write(stored: StoredProposal): void {
    writeFileAtomic(this.#deps.path, `${JSON.stringify(stored, null, 2)}\n`);
  }

  #remove(): void {
    rmSync(this.#deps.path, { force: true });
  }
}
