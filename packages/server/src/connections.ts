// Live Client sessions on the Server: admission, one active session per client_id, stale detection and request
// routing. Registered Clients, projects and public keys come only from the config store; nothing a Client says
// about itself adds a project. Every socket gets a fresh challenge first; the Client's hello proves possession of its
// Ed25519 key. A valid hello from an unknown client_id registers it as Pending and is refused; only a human Enable (config) lets
// a Client in, and Disable closes its session here. One Map holds sessions, one Map holds requests awaiting a response, one Map
// holds the key rotations awaiting their answer, and a response can only settle the request that was sent on the same session.
// A request is never sent twice.
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { newNonce, verifyChallenge, verifyClientAuth } from "@reach-mcp/shared/identity";
import { realSchedule, type Schedule } from "@reach-mcp/shared/timers";
import {
  ClientAuthBegin,
  ClientHello,
  type ClientUpdateState,
  failureResponse,
  incompatibleBuildError,
  isMutation,
  MUTATION_INDETERMINATE_ERROR,
  parseWire,
  RequestEnvelope,
  ResponseEnvelope,
  SessionMessage,
  type Operation,
  type ServerProof,
  type UpdateApplyResult,
  type WireError,
} from "@reach-mcp/shared/wire";
import { NO_AUDIT, type Audit } from "./audit.ts";
import { clientRuntimeOf, type RuntimeSettings } from "@reach-mcp/shared/runtime-settings";
import type { ClientAdmission, ServerConfigStore } from "./config.ts";
import { NO_LOGGER, type Logger } from "./logging.ts";
import { UpdateLifecycle, type UpdateStatus } from "./update-lifecycle.ts";

export type ConnectionOptions = {
  config: ServerConfigStore;
  /** This Server's own opaque build identifier, sent in the welcome and in build refusals. */
  serverBuild: string;
  /** The whole compatibility rule: true or false for a Client's opaque build identifier. */
  isBuildCompatible: (clientBuild: string) => boolean;
  /** The live runtime knobs; default: the Server config's. Read at the moment each value is needed, so a config change applies without a restart. */
  settings?: () => RuntimeSettings;
  /** Time a new socket has to deliver its hello. Overrides the setting (tests). */
  handshakeTimeoutMs?: number;
  /** A session silent for this long is stale. */
  staleMs?: number;
  /** How long a caller of route() waits for a response, and the Client for a key rotation. */
  requestTimeoutMs?: number;
  /** Most requests awaiting a response at once, across all Clients. */
  maxPendingRequests?: number;
  /**
   * The Server trust key (ADR-0005). With it, every welcome and reject for a Client that sent its own nonce carries a signed proof, and a hello
   * WITHOUT that nonce (a pre-change Client) is admitted only as an incompatible, management-only session, which is how it gets updated. Without it
   * (tests, setup) no proof is sent and the one-way handshake of ADR-0004 applies.
   */
  trust?: { proof(outcome: string, clientNonce: string, serverNonce: string): ServerProof };
  now?: () => number;
  schedule?: Schedule;
  /** Operational log and audit trail; the registry emits its own lifecycle events directly. Default: none. */
  logger?: Logger;
  audit?: Audit;
};

/** `compatible` false is a management-only session: authenticated and live, but never given policy, requests or key rotation. */
type Session = { clientId: string; socket: WebSocket; build: string; compatible: boolean; updateCapable: boolean; connectedSince: number; lastSeen: number };
type Handshake = { nonce: string; clientNonce: string | null };
type Rotation = { id: string; session: Session; settle: (result: RotationResult) => void; cancel: () => void };
export type { UpdateStatus } from "./update-lifecycle.ts";
export type UpdateResult = "accepted" | "offline" | "current" | "unsupported" | "busy";
export type RotationResult = "rotated" | "offline" | "busy" | "timeout" | "refused";
type Pending = { session: Session; mutation: boolean; settle: (response: ResponseEnvelope) => void; cancel: () => void };

export type SessionStatus = { client_id: string; client_build: string; compatible: boolean; update_capable: boolean; update: UpdateStatus | null; connected_since: number; last_seen: number; online: boolean };

const withProof = (proof: ServerProof | undefined) => (proof ? { proof } : {});
const AUTH_FAILED: WireError = { code: "AUTH_FAILED", message: "authentication failed" };
const PENDING_APPROVAL: WireError = { code: "PENDING_APPROVAL", message: "client is registered and waits for approval" };
const CLIENT_DISABLED: WireError = { code: "CLIENT_DISABLED", message: "client is disabled" };

export class ClientConnectionRegistry {
  readonly #sessions = new Map<string, Session>();
  readonly #pending = new Map<string, Pending>();
  readonly #rotations = new Map<string, Rotation>();
  /** Every update attempt of every Client, kept across reconnects; terminal states come from a receipt only. */
  readonly #updates = new UpdateLifecycle();
  /** When each Client was last heard, kept after its session ends so the Clients screen can say "seen 2h ago". */
  readonly #lastHeard = new Map<string, number>();
  /** The Client build of each Client's latest session, kept after the session ends so the version stays observable offline. */
  readonly #lastBuild = new Map<string, string>();
  readonly #options: ConnectionOptions;
  readonly #settings: () => RuntimeSettings;
  readonly #maxPending: number;
  readonly #now: () => number;
  readonly #schedule: Schedule;
  readonly #logger: Logger;
  readonly #audit: Audit;
  #cancelSweep: (() => void) | null = null;
  /** Outcomes of requests that were sent; the only request counters in the Server. */
  #completed = 0;
  #failed = 0;
  #timedOut = 0;

  constructor(options: ConnectionOptions) {
    this.#options = options;
    this.#settings = options.settings ?? (() => options.config.runtimeSettings());
    this.#maxPending = options.maxPendingRequests ?? 1000;
    for (const value of [options.handshakeTimeoutMs ?? 1, options.staleMs ?? 1, options.requestTimeoutMs ?? 1, this.#maxPending]) {
      if (!Number.isFinite(value) || value <= 0) throw new RangeError("invalid connection options");
    }
    this.#now = options.now ?? Date.now;
    this.#schedule = options.schedule ?? realSchedule;
    this.#logger = options.logger ?? NO_LOGGER;
    this.#audit = options.audit ?? NO_AUDIT;
  }

  #handshakeTimeoutMs = (): number => this.#options.handshakeTimeoutMs ?? this.#settings().handshake_timeout_ms;
  #staleMs = (): number => this.#options.staleMs ?? this.#settings().stale_ms;
  #requestTimeoutMs = (): number => this.#options.requestTimeoutMs ?? this.#settings().request_timeout_ms;

  /** Starts the periodic stale check; stop() ends it. */
  start(): void {
    if (this.#cancelSweep) return;
    const arm = () => {
      this.#cancelSweep = this.#schedule(() => {
        this.sweep();
        arm();
      }, Math.max(1, Math.floor(this.#staleMs() / 3)));
    };
    arm();
  }

  stop(): void {
    this.#cancelSweep?.();
    this.#cancelSweep = null;
  }

  /** Takes over a freshly upgraded socket and challenges it. It is unauthenticated until a valid hello is admitted. */
  accept(socket: WebSocket, remoteAddress: string | undefined): void {
    /** The handshake of this socket: its challenge, and the client nonce once a current Client sent `auth_begin` and received the Server proof. */
    const handshake: Handshake = { nonce: newNonce(), clientNonce: null };
    let session: Session | null = null;
    const cancelHandshake = this.#schedule(() => {
      if (!session) socket.terminate();
    }, this.#handshakeTimeoutMs());
    socket.on("error", () => undefined);
    socket.on("close", () => {
      cancelHandshake();
      if (session) this.#drop(session);
    });
    socket.on("ping", () => session && (session.lastSeen = this.#now()));
    socket.on("pong", () => session && (session.lastSeen = this.#now()));
    socket.on("message", (data, isBinary) => {
      if (session) {
        session.lastSeen = this.#now();
        return this.#onResponse(session, data, isBinary);
      }
      session = this.#onHandshakeFrame(socket, handshake, remoteAddress, data, isBinary);
      if (session) cancelHandshake();
    });
    socket.send(JSON.stringify({ kind: "challenge", nonce: handshake.nonce }));
  }

  /** Sends the current full policy snapshot to one connected, enabled Client. */
  syncPolicy(clientId: string): boolean {
    const session = this.#sessions.get(clientId);
    const policies = this.#options.config.effectivePoliciesFor(clientId);
    if (!session || !session.compatible || !policies) return false;
    return this.#send(session, { kind: "policy_sync", policies, runtime: clientRuntimeOf(this.#settings()) });
  }

  /** Call after a known config reload. */
  syncAllPolicies(): void {
    for (const clientId of this.#sessions.keys()) this.syncPolicy(clientId);
  }

  /** Small request totals for the health snapshot. */
  requestCounters(): { in_flight: number; completed: number; failed: number; timed_out: number } {
    return { in_flight: this.#pending.size, completed: this.#completed, failed: this.#failed, timed_out: this.#timedOut };
  }

  /** When the Client was last heard: live while connected, remembered after it left; null if never connected since this process started. */
  lastSeen(clientId: string): number | null {
    return this.#sessions.get(clientId)?.lastSeen ?? this.#lastHeard.get(clientId) ?? null;
  }

  /** Closes the Client's live session now, failing what it carried; the human Disable. The Client is refused on reconnect by its status. */
  disconnect(clientId: string): void {
    const session = this.#sessions.get(clientId);
    if (!session) return;
    this.#drop(session);
    session.socket.terminate();
  }

  /**
   * Asks the connected, enabled Client to generate a new Ed25519 pair locally and waits for the answer: only its public key
   * comes back and is STAGED next to the valid key (one atomic config write). Only then is the Client told to commit; it makes the
   * new key its own and reconnects, and the first hello that proves the staged key promotes it and retires the old one (#admit).
   * Until that proof the old key keeps working, so no single failure leaves the Client and the Server without a common key.
   * One rotation per Client at a time; a Client that is not connected is refused, nothing is queued.
   */
  rotateKey(clientId: string): Promise<RotationResult> {
    const session = this.#sessions.get(clientId);
    if (!session || this.#isStale(session) || this.#options.config.admissionOf(clientId)?.status !== "enabled") return Promise.resolve("offline");
    if (!session.compatible) return Promise.resolve("refused");
    if (this.#rotations.has(clientId)) return Promise.resolve("busy");
    const id = this.#newId("rot");
    return new Promise<RotationResult>((resolve) => {
      const settle = (result: RotationResult) => {
        if (!this.#rotations.delete(clientId)) return;
        cancel();
        this.#logger.log(result === "rotated" ? "RUNNING" : "WARNING", "connections", `key rotation ${result} client_id=${clientId}`);
        this.#audit.record({ actor: "admin", action: "rotate_key", client_id: clientId, result });
        resolve(result);
      };
      const cancel = this.#schedule(() => settle("timeout"), this.#requestTimeoutMs());
      this.#rotations.set(clientId, { id, session, settle, cancel });
      if (!this.#send(session, { kind: "rotate_key", rotation_id: id })) settle("offline");
    });
  }

  /**
   * The explicit operator command to update one connected, enabled Client to the Server's canonical release build. The frame carries nothing:
   * the Client resolves the release manifest itself. Allowed on an incompatible (management-only) session, because that is exactly the Client
   * that needs it; refused for a Client already on the Server's build (nothing to do) and for a Client that did not say it can update (a pre-change Client has no handler and would drop the socket) and
   * while another update of the same Client is in flight. Nothing is queued: an offline Client is refused.
   */
  requestUpdate(clientId: string): UpdateResult {
    const session = this.#sessions.get(clientId);
    if (!session || this.#isStale(session) || this.#options.config.admissionOf(clientId)?.status !== "enabled") return this.#recordUpdate(clientId, "offline");
    if (session.build === this.#options.serverBuild) return this.#recordUpdate(clientId, "current");
    if (!session.updateCapable) return this.#recordUpdate(clientId, "unsupported");
    if (this.#updates.isHeldBy(clientId, session)) return this.#recordUpdate(clientId, "busy");
    const updateId = this.#newId("update");
    this.#updates.begin(clientId, session, { update_id: updateId, from_build: session.build, target_build: this.#options.serverBuild });
    if (!this.#send(session, { kind: "update", update_id: updateId })) {
      this.#updates.discard(clientId, updateId);
      return this.#recordUpdate(clientId, "offline");
    }
    return this.#recordUpdate(clientId, "accepted");
  }

  /** The one place an update request is logged and audited, with the Client id and the result only. */
  #recordUpdate(clientId: string, result: UpdateResult): UpdateResult {
    this.#logger.log(result === "accepted" ? "RUNNING" : "WARNING", "connections", `client update ${result} client_id=${clientId}${this.#who(clientId)}`);
    this.#audit.record({ actor: "admin", action: "client_update", client_id: clientId, result });
    return result;
  }

  /** The build the Client reported on its latest connection, or null when it has never connected since the Server started. */
  lastBuild(clientId: string): string | null {
    return this.#lastBuild.get(clientId) ?? null;
  }

  status(): SessionStatus[] {
    return [...this.#sessions.values()].map((s) => ({ client_id: s.clientId, client_build: s.build, compatible: s.compatible, update_capable: s.updateCapable, update: this.#updates.status(s.clientId), connected_since: s.connectedSince, last_seen: s.lastSeen, online: !this.#isStale(s) }));
  }

  /** Terminates every stale session. */
  sweep(): void {
    for (const session of [...this.#sessions.values()]) {
      if (!this.#isStale(session)) continue;
      this.#logger.log("WARNING", "connections", `client stale client_id=${session.clientId}`);
      session.socket.terminate();
    }
  }

  /**
   * Sends one request to the addressed Client and resolves with its response, or with an error response. The Client and
   * project must be in the current configuration. Never rejects and never sends the same request twice.
   */
  route(clientId: string, projectId: string, operation: Operation, options: { requestId?: string } = {}): Promise<ResponseEnvelope> {
    const requestId = options.requestId ?? this.#newId("req");
    const refuse = (error: WireError) => Promise.resolve(failureResponse(requestId, error));
    const policies = this.#options.config.effectivePoliciesFor(clientId);
    if (!policies) return refuse({ code: "NOT_FOUND", message: "unknown client" });
    if (!policies.some((p) => p.project_id === projectId)) return refuse({ code: "NOT_FOUND", message: "unknown project" });
    const session = this.#sessions.get(clientId);
    if (!session || this.#isStale(session) || session.socket.readyState !== WebSocket.OPEN) return refuse({ code: "NOT_FOUND", message: "client is offline" });
    if (!session.compatible) return refuse(incompatibleBuildError(session.build, this.#options.serverBuild));
    if (this.#pending.size >= this.#maxPending) return refuse({ code: "INTERNAL", message: "too many pending requests" });
    if (this.#pending.has(requestId)) return refuse({ code: "BAD_REQUEST", message: "request id already in flight" });
    const envelope = parseWire(RequestEnvelope, { kind: "request", request_id: requestId, project_id: projectId, operation });
    if (!envelope.ok) return refuse(envelope.error);
    const mutation = isMutation(operation.op);
    return new Promise<ResponseEnvelope>((resolve) => {
      let timedOut = false;
      const settle = (response: ResponseEnvelope) => {
        if (!this.#pending.delete(requestId)) return;
        cancel();
        if (timedOut) this.#timedOut++;
        else if (response.ok) this.#completed++;
        else this.#failed++;
        this.#recordOutcome(clientId, projectId, operation, response, timedOut);
        resolve(response);
      };
      const cancel = this.#schedule(() => {
        timedOut = true;
        settle(failureResponse(requestId, this.#lost(mutation, "request timed out")));
      }, this.#requestTimeoutMs());
      this.#pending.set(requestId, { session, mutation, settle, cancel });
      if (!this.#send(session, envelope.data)) settle(failureResponse(requestId, this.#lost(mutation, "client is offline")));
    });
  }

  /** The safe identity of a Client for a log line: Machine UUID, friendly name and build, each only when known. Never a key or a digest. */
  #who(clientId: string): string {
    const summary = this.#options.config.clientSummaries().find((c) => c.client_id === clientId);
    const parts = [
      ["machine_uuid", this.#admissionOf(clientId)?.machineUuid],
      ["display_name", summary?.display_name?.replaceAll(/\s+/g, "_")],
      ["client_build", this.#lastBuild.get(clientId)],
    ];
    return parts.flatMap(([key, value]) => (value ? [` ${key}=${value}`] : [])).join("");
  }

  /** The one place a sent request is logged and, if it changes files, audited: exactly once, at its terminal outcome. */
  #recordOutcome(clientId: string, projectId: string, operation: Operation, response: ResponseEnvelope, timedOut: boolean): void {
    const where = `op=${operation.op} client_id=${clientId} project_id=${projectId}${this.#who(clientId)}`;
    const result = timedOut ? "timed_out" : response.ok ? "ok" : response.error.code;
    if (timedOut) this.#logger.log("ERROR", "connections", `request timed out ${where}`, response.request_id);
    else if (response.ok) this.#logger.log("INFO", "connections", `request completed ${where}`, response.request_id);
    else this.#logger.log("WARNING", "connections", `request failed ${where} code=${response.error.code}`, response.request_id);
    if (isMutation(operation.op)) {
      this.#audit.record({ actor: "chatgpt", action: operation.op, client_id: clientId, project_id: projectId, ...("path" in operation ? { target: operation.path } : {}), request_id: response.request_id, result });
    }
  }

  /** What a caller learns when no response arrived: a mutation may or may not have run, a read simply failed. */
  #lost(mutation: boolean, text: string): WireError {
    return mutation ? MUTATION_INDETERMINATE_ERROR : { code: "INTERNAL", message: text };
  }

  /** The one id generator of the registry: a prefix and a random UUID, for requests and rotations alike. */
  #newId(prefix: string): string {
    return `${prefix}-${randomUUID()}`;
  }

  #isStale(session: Session): boolean {
    return this.#now() - session.lastSeen >= this.#staleMs();
  }

  #send(session: Session, frame: object): boolean {
    if (this.#sessions.get(session.clientId) !== session || session.socket.readyState !== WebSocket.OPEN) return false;
    session.socket.send(JSON.stringify(frame));
    return true;
  }

  #reject(socket: WebSocket, error: WireError, serverBuild?: string, proof?: ServerProof): null {
    this.#logger.log("WARNING", "connections", `client refused code=${error.code}`);
    socket.send(JSON.stringify({ kind: "reject", ...(serverBuild ? { server_build: serverBuild } : {}), error, ...(proof ? { proof } : {}) }));
    socket.close();
    return null;
  }

  /**
   * The frames a socket may send before it is admitted. A current Client sends `auth_begin` (only its nonce) first and gets the Server proof back, no
   * session yet; its hello follows and is checked against that stage. Anything else is the hello of a pre-change Client, which only the legacy rules admit.
   */
  #onHandshakeFrame(socket: WebSocket, handshake: Handshake, remoteAddress: string | undefined, data: WebSocket.RawData, isBinary: boolean): Session | null {
    let frame: unknown;
    try {
      if (isBinary) throw new Error("binary");
      frame = JSON.parse(data.toString());
    } catch {
      return this.#reject(socket, { code: "BAD_REQUEST", message: "invalid handshake frame" });
    }
    if ((frame as { kind?: unknown } | null)?.kind !== "auth_begin") return this.#admit(socket, handshake, remoteAddress, frame);
    const begin = parseWire(ClientAuthBegin, frame);
    if (!begin.ok) return this.#reject(socket, begin.error);
    // One begin per socket and only when this Server can prove itself: otherwise the Client would be left unauthenticated, so it is refused without a proof.
    if (handshake.clientNonce !== null || !this.#options.trust) return this.#reject(socket, { code: "BAD_REQUEST", message: "invalid handshake frame" });
    handshake.clientNonce = begin.data.client_nonce;
    socket.send(JSON.stringify({ kind: "server_auth", proof: this.#options.trust.proof("auth", handshake.clientNonce, handshake.nonce) }));
    return null;
  }

  /** Checks the hello of a socket against its own challenge and handshake stage; returns the new session, or null after refusing it. */
  #admit(socket: WebSocket, handshake: Handshake, remoteAddress: string | undefined, frame: unknown): Session | null {
    const nonce = handshake.nonce;
    const hello = parseWire(ClientHello, frame);
    if (!hello.ok) return this.#reject(socket, hello.error);
    const { client_id: clientId, client_build: build, public_key: publicKey, signature, client_nonce: clientNonce, display_name: displayName, machine_uuid: machineUuid, update_capable: updateCapable } = hello.data;
    // The Server proves itself over the Client's own nonce, so a recorded answer cannot be replayed to another connection.
    const proofFor = (outcome: string): ServerProof | undefined => (clientNonce !== undefined ? this.#options.trust?.proof(outcome, clientNonce, nonce) : undefined);
    const reject = (error: WireError, serverBuild?: string): null => this.#reject(socket, error, serverBuild, proofFor(`reject:${error.code}`));
    // A registered Client must present a stored key (current or staged) whatever its status; an unknown one proves possession of the key it offers.
    const known = this.#admissionOf(clientId);
    const key = known ? [known.publicKey, known.nextPublicKey].find((k) => k !== null && k === publicKey) : publicKey;
    // A current hello belongs to a socket whose Server proof was already given over the SAME client nonce; skipping that phase, or changing the nonce, is refused.
    if ((clientNonce !== undefined || handshake.clientNonce !== null) && clientNonce !== (handshake.clientNonce ?? undefined)) return reject(AUTH_FAILED);
    const proven = key !== undefined && key !== null && (clientNonce !== undefined ? verifyClientAuth(key, nonce, clientNonce, clientId, signature) : verifyChallenge(key, nonce, clientId, signature));
    if (!proven) return reject(AUTH_FAILED);
    // Only a known, Enabled Client may stay connected with an incompatible build (management only); everyone else is refused as before.
    const compatible = this.#options.isBuildCompatible(build);
    // A compatible Client that never contributed a nonce would be a downgrade of the mutual handshake: refused when the Server has a trust key.
    if (compatible && clientNonce === undefined && this.#options.trust) return reject(AUTH_FAILED);
    if (!compatible && known?.status !== "enabled") return reject(incompatibleBuildError(build, this.#options.serverBuild), this.#options.serverBuild);
    if (!known) return reject(this.#register(clientId, publicKey, displayName, machineUuid) ? PENDING_APPROVAL : AUTH_FAILED);
    if (!this.#reconcileMachine(clientId, known.machineUuid, machineUuid)) return reject(AUTH_FAILED);
    if (known.status !== "enabled") return reject(known.status === "pending" ? PENDING_APPROVAL : CLIENT_DISABLED);
    if (known.nextPublicKey === publicKey) this.#promoteKey(clientId);
    const existing = this.#sessions.get(clientId);
    if (existing && !this.#isStale(existing)) return reject({ code: "DUPLICATE_CLIENT", message: "client is already connected" });
    if (existing) {
      this.#drop(existing);
      existing.socket.terminate();
    }
    const now = this.#now();
    const session: Session = { clientId, socket, build, compatible, updateCapable: updateCapable === true, connectedSince: now, lastSeen: now };
    this.#sessions.set(clientId, session);
    this.#lastBuild.set(clientId, build);
    this.#logger.log("RUNNING", "connections", `client connected client_id=${clientId}${this.#who(clientId)}`);
    // The welcome is the exact frame pre-change Clients already parse (their schema is strict and accepts only compatible=true), so an
    // incompatible Client is never told apart on the wire: the Server-owned `session.compatible` is the only authority and gives it no policy.
    this.#send(session, { kind: "welcome", server_build: this.#options.serverBuild, compatible: true, runtime: clientRuntimeOf(this.#settings()), ...withProof(proofFor("welcome")) });
    this.syncPolicy(clientId);
    return session;
  }

  /** The registered Client's status and stored key; with no active configuration it reads as registered and keyless, so nobody is registered or admitted. */
  #admissionOf(clientId: string): ClientAdmission {
    try {
      return this.#options.config.admissionOf(clientId);
    } catch {
      return { status: "disabled", publicKey: null, nextPublicKey: null, machineUuid: null };
    }
  }

  /** The Client just proved its staged key: it becomes the key. A failed write is not fatal, the staged key stays valid and the next proof retries. */
  #promoteKey(clientId: string): void {
    try {
      this.#options.config.promoteClientPublicKey(clientId);
    } catch {
      return void this.#logger.log("WARNING", "connections", `key promotion not persisted client_id=${clientId}`);
    }
    this.#logger.log("RUNNING", "connections", `key promoted client_id=${clientId}`);
    this.#audit.record({ actor: "client", action: "key_promoted", client_id: clientId, result: "ok" });
  }

  /**
   * An authenticated Client reports the Machine UUID of its machine. A record without one (a legacy random client_id) binds it once; a
   * record that has one must see the same value, otherwise the identity was copied to another machine and is refused. The Machine UUID is
   * correlation only: it never replaces a key, so it is checked only after the Ed25519 proof, and a Client that reports none is unchanged.
   */
  #reconcileMachine(clientId: string, stored: string | null, reported: string | undefined): boolean {
    if (reported === undefined || reported === stored) return true;
    if (stored !== null) {
      this.#logger.log("WARNING", "connections", `machine_uuid mismatch client_id=${clientId}`);
      return false;
    }
    try {
      this.#options.config.bindMachineUuid(clientId, reported);
    } catch {
      this.#logger.log("WARNING", "connections", `machine_uuid not bound client_id=${clientId}`);
      return false;
    }
    this.#logger.log("RUNNING", "connections", `machine_uuid bound client_id=${clientId}`);
    this.#audit.record({ actor: "client", action: "machine_uuid_bound", client_id: clientId, result: "ok" });
    return true;
  }

  /** The one registration write: an unknown Client becomes Pending; logged and audited without any key material. */
  #register(clientId: string, publicKey: string, displayName: string | undefined, machineUuid: string | undefined): boolean {
    try {
      this.#options.config.registerPendingClient(clientId, publicKey, displayName, machineUuid);
    } catch {
      return false;
    }
    this.#logger.log("RUNNING", "connections", `client registered pending client_id=${clientId}`);
    this.#audit.record({ actor: "client", action: "register_pending", client_id: clientId, result: "ok" });
    return true;
  }

  #onResponse(session: Session, data: WebSocket.RawData, isBinary: boolean): void {
    let frame: unknown;
    try {
      if (isBinary) throw new Error("binary");
      frame = JSON.parse(data.toString());
    } catch {
      return session.socket.terminate();
    }
    const message = parseWire(SessionMessage, frame);
    if (!message.ok) return session.socket.terminate();
    if (message.data.kind === "rotated") return this.#onRotated(session, message.data);
    if (message.data.kind === "update_state") return this.#onUpdateState(session, message.data);
    if (message.data.kind === "update_receipt") return this.#onUpdateReceipt(session, message.data.receipt);
    const pending = this.#pending.get(message.data.request_id);
    // A response settles only the request it answers, and only on the session that carried it; anything else is dropped.
    if (pending && pending.session === session) pending.settle(message.data);
  }

  /** An update state counts only for the attempt asked on this very session; it is logged and audited once per state the Client reports. */
  #onUpdateState(session: Session, report: ClientUpdateState): void {
    if (this.#updates.progress(session.clientId, session, report) !== "recorded") return;
    this.#recordClientUpdate(session.clientId, report.state === "failed" ? `failed:${report.reason}` : report.state, report.state === "failed");
  }

  /** The terminal apply receipt: accepted on any authenticated session, so it survives a reconnect and a Server restart; a repeat changes and logs nothing, a conflict changes nothing. */
  #onUpdateReceipt(session: Session, receipt: UpdateApplyResult): void {
    const outcome = this.#updates.receipt(session.clientId, session, receipt);
    if (outcome === "duplicate") return;
    const result = outcome === "recorded" ? (receipt.state === "failed" ? `failed:${receipt.reason}` : receipt.state) : `receipt_${outcome}`;
    this.#recordClientUpdate(session.clientId, result, outcome !== "recorded" || receipt.state === "failed");
  }

  /** The one place a Client-reported update state is logged and audited, with the Client id and the result only. */
  #recordClientUpdate(clientId: string, result: string, warning: boolean): void {
    this.#logger.log(warning ? "WARNING" : "RUNNING", "connections", `client update ${result} client_id=${clientId}${this.#who(clientId)}`);
    this.#audit.record({ actor: "client", action: "client_update_state", client_id: clientId, result });
  }

  /** The Client's answer to a rotation: only the one asked, on the session that was asked, stages its new key; it is told to commit only once that is stored. */
  #onRotated(session: Session, answer: { rotation_id: string; public_key: string }): void {
    const rotation = this.#rotations.get(session.clientId);
    if (!rotation || rotation.session !== session || rotation.id !== answer.rotation_id) return;
    try {
      this.#options.config.stageClientPublicKey(session.clientId, answer.public_key);
    } catch {
      return rotation.settle("refused");
    }
    this.#send(session, { kind: "rotate_committed", rotation_id: answer.rotation_id });
    rotation.settle("rotated");
    this.#drop(session);
    session.socket.close();
  }

  /** Forgets a session if it is still the registered one and fails the requests it carried. */
  #drop(session: Session): void {
    if (this.#sessions.get(session.clientId) !== session) return;
    this.#sessions.delete(session.clientId);
    this.#updates.sessionEnded(session.clientId, session);
    this.#lastHeard.set(session.clientId, session.lastSeen);
    this.#rotations.get(session.clientId)?.settle("offline");
    this.#logger.log("RUNNING", "connections", `client disconnected client_id=${session.clientId}${this.#who(session.clientId)}`);
    for (const [id, pending] of [...this.#pending]) {
      if (pending.session === session) pending.settle(failureResponse(id, this.#lost(pending.mutation, "client disconnected")));
    }
  }
}
