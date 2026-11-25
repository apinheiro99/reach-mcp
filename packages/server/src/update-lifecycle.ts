// The Server's one record of Client update attempts (ADR-0005 trust chain, Story #154). It owns only the state machine: the attempt a Server minted, the
// progress the Client reports before the handoff, and the terminal apply receipt the privileged wrapper wrote. It never sends or logs anything, and it never
// treats a reconnect or a build as success: `applied` and the post-handoff `failed` come from a receipt only. The attempt in flight and the last terminal result are kept apart.
import type { ClientUpdateState, UpdateApplyResult, UpdateFailure } from "@reach-mcp/shared/wire";

export type UpdateState = "requested" | "staging" | "restarting" | "applied" | "failed";
export type UpdateStatus = { update_id: string; state: UpdateState; reason?: UpdateFailure; from_build: string; target_build: string; artifact_sha256?: string };
/** What happened to a reported receipt: `ignored` is an old receipt that must not override a newer attempt in flight. */
export type ReceiptOutcome = "recorded" | "duplicate" | "conflict" | "ignored";
export type ProgressOutcome = "recorded" | "ignored";

type Attempt = { status: UpdateStatus; holder: object };
/** What an operator sees for one Client: the attempt in flight, and the last terminal result kept apart from it so a retry never erases it. */
export type UpdateView = { current: UpdateStatus | null; last: UpdateStatus | null };
/** Before the handoff nothing was applied and nothing can come back: the attempt dies with the session that held it. */
const PRE_HANDOFF: ReadonlySet<UpdateState> = new Set(["requested", "staging"]);
/** The only moves a Client report may make; a duplicate or a step back (restarting -> staging) is not on the list. `failed` stays possible until a receipt, because the trigger can fail after `restarting` was reported. */
const NEXT: Readonly<Record<"requested" | "staging" | "restarting", readonly string[]>> = { requested: ["staging", "failed"], staging: ["restarting", "failed"], restarting: ["failed"] };

export class UpdateLifecycle {
  /** The one attempt in flight per Client, requested/staging/restarting only. */
  readonly #current = new Map<string, Attempt>();
  /** The last terminal result per Client (applied, or failed before or after the handoff). It changes only when another terminal result arrives, never when an attempt starts. */
  readonly #last = new Map<string, UpdateStatus>();

  /** Both facts of the Client, with or without a live session. */
  view(clientId: string): UpdateView {
    return { current: this.#current.get(clientId)?.status ?? null, last: this.#last.get(clientId) ?? null };
  }

  /** The latest fact of the Client: the attempt in flight, else the last terminal result; null when none is known (never asked, or the Server restarted and no receipt came back). */
  status(clientId: string): UpdateStatus | null {
    const { current, last } = this.view(clientId);
    return current ?? last;
  }

  /** True while the Client has an attempt in flight, whichever session asked: an attempt handed off (`restarting`) blocks every new one across reconnects until its terminal result. */
  hasInFlight(clientId: string): boolean {
    return this.#current.has(clientId);
  }

  /** Records a new attempt on the session that was asked, with a fresh id; the last terminal result stays as it was. */
  begin(clientId: string, holder: object, update: { update_id: string; from_build: string; target_build: string }): void {
    this.#current.set(clientId, { holder, status: { ...update, state: "requested" } });
  }

  /** Forgets an attempt whose command could not be sent. */
  discard(clientId: string, updateId: string): void {
    if (this.#current.get(clientId)?.status.update_id === updateId) this.#current.delete(clientId);
  }

  /** The Client's progress counts only for the attempt in flight, from the session that was asked, and only as an allowed move: never backwards, a duplicate changes nothing. A reported failure ends the attempt and becomes the last terminal result. */
  progress(clientId: string, holder: object, report: ClientUpdateState): ProgressOutcome {
    const attempt = this.#current.get(clientId);
    if (!attempt || attempt.holder !== holder || attempt.status.update_id !== report.update_id) return "ignored";
    if (!NEXT[attempt.status.state as keyof typeof NEXT].includes(report.state)) return "ignored";
    const { update_id, from_build, target_build } = attempt.status;
    if (report.state === "failed") {
      this.#last.set(clientId, { update_id, from_build, target_build, state: "failed", reason: report.reason });
      this.#current.delete(clientId);
    } else {
      attempt.status = { update_id, from_build, target_build, state: report.state };
    }
    return "recorded";
  }

  /**
   * The terminal apply receipt of an authenticated Client, accepted on any session and after a Server restart. A match for the attempt in flight finishes it and becomes
   * the last terminal result; an older receipt never overrides a newer attempt in flight; otherwise it restores the last terminal result and creates nothing in flight.
   * The same terminal result again is a no-op, and a different build, hash or state for the same attempt is a conflict that changes nothing.
   */
  receipt(clientId: string, receipt: UpdateApplyResult): ReceiptOutcome {
    const terminal: UpdateStatus = { update_id: receipt.update_id, from_build: receipt.from_build, target_build: receipt.target_build, artifact_sha256: receipt.artifact_sha256, state: receipt.state, ...(receipt.state === "failed" ? { reason: receipt.reason } : {}) };
    const attempt = this.#current.get(clientId);
    if (attempt) {
      const known = attempt.status;
      if (known.update_id !== receipt.update_id) return "ignored";
      if (known.from_build !== receipt.from_build || known.target_build !== receipt.target_build) return "conflict";
      this.#last.set(clientId, terminal);
      this.#current.delete(clientId);
      return "recorded";
    }
    const last = this.#last.get(clientId);
    if (last?.update_id !== receipt.update_id) {
      this.#last.set(clientId, terminal);
      return "recorded";
    }
    const same = last.from_build === terminal.from_build && last.target_build === terminal.target_build && last.artifact_sha256 === terminal.artifact_sha256 && last.state === terminal.state && last.reason === terminal.reason;
    return same ? "duplicate" : "conflict";
  }

  /** The session ended: an attempt that never reached the handoff dies with it; one already handed off stays `restarting` until a receipt says otherwise. */
  sessionEnded(clientId: string, holder: object): void {
    const attempt = this.#current.get(clientId);
    if (attempt && attempt.holder === holder && PRE_HANDOFF.has(attempt.status.state)) this.#current.delete(clientId);
  }
}
