// The Server's one record of Client update attempts (ADR-0005 trust chain, Story #154). It owns only the state machine: the attempt a Server minted, the
// progress the Client reports before the handoff, and the terminal apply receipt the privileged wrapper wrote. It never sends or logs anything, and it never
// treats a reconnect or a build as success: `applied` and the post-handoff `failed` come from a receipt only.
import type { ClientUpdateState, UpdateApplyResult, UpdateFailure } from "@reach-mcp/shared/wire";

export type UpdateState = "requested" | "staging" | "restarting" | "applied" | "failed";
export type UpdateStatus = { update_id: string; state: UpdateState; reason?: UpdateFailure; from_build: string; target_build: string; artifact_sha256?: string };
/** What happened to a reported receipt: `ignored` is an old receipt that must not override a newer attempt in flight. */
export type ReceiptOutcome = "recorded" | "duplicate" | "conflict" | "ignored";
export type ProgressOutcome = "recorded" | "ignored";

type Attempt = { status: UpdateStatus; holder: object };
const IN_FLIGHT: ReadonlySet<UpdateState> = new Set(["requested", "staging", "restarting"]);
/** Before the handoff nothing was applied and nothing can come back: the attempt dies with the session that held it. */
const PRE_HANDOFF: ReadonlySet<UpdateState> = new Set(["requested", "staging"]);
/** The only moves a Client report may make; a duplicate or a step back (restarting -> staging) is not on the list. `failed` stays possible until a receipt, because the trigger can fail after `restarting` was reported. */
const NEXT: Readonly<Record<"requested" | "staging" | "restarting", readonly string[]>> = { requested: ["staging", "failed"], staging: ["restarting", "failed"], restarting: ["failed"] };

export class UpdateLifecycle {
  readonly #attempts = new Map<string, Attempt>();

  /** The latest attempt of the Client, in flight or terminal; null when none is known (never asked, or the Server restarted and no receipt came back). */
  status(clientId: string): UpdateStatus | null {
    return this.#attempts.get(clientId)?.status ?? null;
  }

  /** True while the Client has an attempt that is not terminal, whichever session asked: an attempt handed off (`restarting`) blocks every new one across reconnects until its receipt; only a terminal state frees the slot. */
  hasInFlight(clientId: string): boolean {
    const attempt = this.#attempts.get(clientId);
    return attempt !== undefined && IN_FLIGHT.has(attempt.status.state);
  }

  /** Records a new attempt on the session that was asked; a retry always comes with a fresh id and replaces the previous record. */
  begin(clientId: string, holder: object, update: { update_id: string; from_build: string; target_build: string }): void {
    this.#attempts.set(clientId, { holder, status: { ...update, state: "requested" } });
  }

  /** Forgets an attempt whose command could not be sent. */
  discard(clientId: string, updateId: string): void {
    if (this.#attempts.get(clientId)?.status.update_id === updateId) this.#attempts.delete(clientId);
  }

  /** The Client's progress counts only for the attempt in flight, from the session that was asked, and only as an allowed move: never backwards, a duplicate changes nothing. */
  progress(clientId: string, holder: object, report: ClientUpdateState): ProgressOutcome {
    const attempt = this.#attempts.get(clientId);
    if (!attempt || attempt.holder !== holder || attempt.status.update_id !== report.update_id || !IN_FLIGHT.has(attempt.status.state)) return "ignored";
    if (!NEXT[attempt.status.state as keyof typeof NEXT].includes(report.state)) return "ignored";
    const { update_id, from_build, target_build } = attempt.status;
    attempt.status = report.state === "failed" ? { update_id, from_build, target_build, state: "failed", reason: report.reason } : { update_id, from_build, target_build, state: report.state };
    return "recorded";
  }

  /**
   * The terminal apply receipt of an authenticated Client, accepted on any session and after a Server restart. The same attempt: a repeat is a no-op, a different
   * build, hash or state is a conflict that changes nothing, and a match for an attempt in flight finishes it. Another attempt: an older receipt never overrides
   * a newer attempt in flight; otherwise it only restores the last terminal result and creates nothing in flight.
   */
  receipt(clientId: string, holder: object, receipt: UpdateApplyResult): ReceiptOutcome {
    const attempt = this.#attempts.get(clientId);
    const terminal: UpdateStatus = { update_id: receipt.update_id, from_build: receipt.from_build, target_build: receipt.target_build, artifact_sha256: receipt.artifact_sha256, state: receipt.state, ...(receipt.state === "failed" ? { reason: receipt.reason } : {}) };
    if (!attempt || (attempt.status.update_id !== receipt.update_id && !IN_FLIGHT.has(attempt.status.state))) {
      this.#attempts.set(clientId, { holder, status: terminal });
      return "recorded";
    }
    const known = attempt.status;
    if (known.update_id !== receipt.update_id) return "ignored";
    if (IN_FLIGHT.has(known.state)) {
      if (known.from_build !== receipt.from_build || known.target_build !== receipt.target_build) return "conflict";
      attempt.status = terminal;
      return "recorded";
    }
    const same = known.from_build === terminal.from_build && known.target_build === terminal.target_build && known.artifact_sha256 === terminal.artifact_sha256 && known.state === terminal.state && known.reason === terminal.reason;
    return same ? "duplicate" : "conflict";
  }

  /** The session ended: an attempt that never reached the handoff dies with it; one already handed off stays `restarting` until a receipt says otherwise. */
  sessionEnded(clientId: string, holder: object): void {
    const attempt = this.#attempts.get(clientId);
    if (attempt && attempt.holder === holder && PRE_HANDOFF.has(attempt.status.state)) this.#attempts.delete(clientId);
  }
}
