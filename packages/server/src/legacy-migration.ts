// The Server's record of the one-time migration of a first-generation Client (Story #154). A Client built before the receipt protocol knows no `update_id` and writes
// no receipt, so its update can never be receipt-backed. This owner keeps what such a Client reports, labeled as a migration, and is deliberately NOT the UpdateLifecycle:
// it never feeds a terminal result into it, and `completed` here means only "the Client came back announcing the current protocol on the canonical build".
import type { LegacyClientUpdateState, PreHandoffFailure } from "@reach-mcp/shared/wire";

export type MigrationState = "requested" | "staging" | "restarting" | "completed" | "interrupted" | "failed";
export type MigrationStatus = { state: MigrationState; reason?: PreHandoffFailure; active: boolean };

type Entry = { state: MigrationState; reason?: PreHandoffFailure; holder: object };
/** In flight: the Server asked, or the Client reported a state, and nothing ended it yet. */
const ACTIVE: ReadonlySet<MigrationState> = new Set(["requested", "staging", "restarting"]);
const NEXT: Readonly<Record<"requested" | "staging" | "restarting", readonly string[]> > = { requested: ["staging", "failed"], staging: ["restarting", "failed"], restarting: ["failed"] };

export class LegacyMigration {
  readonly #entries = new Map<string, Entry>();

  view(clientId: string): MigrationStatus | null {
    const entry = this.#entries.get(clientId);
    return entry ? { state: entry.state, ...(entry.reason ? { reason: entry.reason } : {}), active: ACTIVE.has(entry.state) } : null;
  }

  hasInFlight(clientId: string): boolean {
    return ACTIVE.has(this.#entries.get(clientId)?.state ?? "completed");
  }

  /** A new migration attempt on the session that was asked; an earlier ended one is replaced. */
  begin(clientId: string, holder: object): void {
    this.#entries.set(clientId, { state: "requested", holder });
  }

  discard(clientId: string, holder: object): void {
    if (this.#entries.get(clientId)?.holder === holder) this.#entries.delete(clientId);
  }

  /** A legacy report counts only on the session asked and only as the next step; returns whether it was recorded. */
  progress(clientId: string, holder: object, report: LegacyClientUpdateState): boolean {
    const entry = this.#entries.get(clientId);
    if (!entry || entry.holder !== holder || !(entry.state in NEXT) || !NEXT[entry.state as "requested" | "staging" | "restarting"].includes(report.state)) return false;
    entry.state = report.state;
    if (report.state === "failed") entry.reason = report.reason;
    else delete entry.reason;
    return true;
  }

  /** Before the handoff the attempt dies with its session; after `restarting` the session is expected to end, and the reconnect decides. */
  sessionEnded(clientId: string, holder: object): void {
    const entry = this.#entries.get(clientId);
    if (entry?.holder === holder && (entry.state === "requested" || entry.state === "staging")) entry.state = "interrupted";
  }

  /** A Client that was restarting is back: it completed the migration only when it now announces protocol 2 on the Server's canonical build; anything else did not. */
  reconnected(clientId: string, protocol2: boolean, onCanonicalBuild: boolean): void {
    const entry = this.#entries.get(clientId);
    if (entry?.state === "restarting") entry.state = protocol2 && onCanonicalBuild ? "completed" : "interrupted";
  }
}
