// Live Client sessions on the Server: admission, one active session per client_id, stale detection and request
// routing. Registered Clients, projects and public keys come only from the config store; nothing a Client says
// about itself adds a project. Every socket gets a fresh challenge first; the Client's hello proves possession of its
// Ed25519 key. A valid hello from an unknown client_id registers it as Pending and is refused; only a human Enable (config) lets
// a Client in, and Disable closes its session here. One Map holds sessions, one Map holds requests awaiting a response, one Map
// holds the key rotations awaiting their answer, and a response can only settle the request that was sent on the same session.
// A request is never sent twice.
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { newNonce, verifyChallenge } from "@reach-mcp/shared/identity";
import { realSchedule, type Schedule } from "@reach-mcp/shared/timers";
import {
  ClientHello,
  failureResponse,
  incompatibleBuildError,
  isMutation,
  MUTATION_INDETERMINATE_ERROR,
  parseWire,
  RequestEnvelope,
  ResponseEnvelope,
  SessionMessage,
  type Operation,
  type WireError,
} from "@reach-mcp/shared/wire";
import { NO_AUDIT, type Audit } from "./audit.ts";
import type { ClientAdmission, ServerConfigStore } from "./config.ts";
import { NO_LOGGER, type Logger } from "./logging.ts";

export type ConnectionOptions = {
  config: ServerConfigStore;
  /** This Server's own opaque build identifier, sent in the welcome and in build refusals. */
  serverBuild: string;
  /** The whole compatibility rule: true or false for a Client's opaque build identifier. */
  isBuildCompatible: (clientBuild: string) => boolean;
  /** Time a new socket has to deliver its hello. */
  handshakeTimeoutMs?: number;
  /** A session silent for this long is stale. */
  staleMs?: number;
  /** How long a caller of route() waits for a response, and the Client for a key rotation. */
  requestTimeoutMs?: number;
  /** Most requests awaiting a response at once, across all Clients. */
  maxPendingRequests?: number;
  now?: () => number;
  schedule?: Schedule;
  /** Operational log and audit trail; the registry emits its own lifecycle events directly. Default: none. */
  logger?: Logger;
  audit?: Audit;
};

type Session = { clientId: string; socket: WebSocket; build: string; connectedSince: number; lastSeen: number };
type Rotation = { id: string; session: Session; settle: (result: RotationResult) => void; cancel: () => void };
export type RotationResult = "rotated" | "offline" | "busy" | "timeout" | "refused";
type Pending = { session: Session; mutation: boolean; settle: (response: ResponseEnvelope) => void; cancel: () => void };

export type SessionStatus = { client_id: string; client_build: string; connected_since: number; last_seen: number; online: boolean };

const AUTH_FAILED: WireError = { code: "AUTH_FAILED", message: "authentication failed" };
const PENDING_APPROVAL: WireError = { code: "PENDING_APPROVAL", message: "client is registered and waits for approval" };
const CLIENT_DISABLED: WireError = { code: "CLIENT_DISABLED", message: "client is disabled" };

export class ClientConnectionRegistry {
  readonly #sessions = new Map<string, Session>();
  readonly #pending = new Map<string, Pending>();
  readonly #rotations = new Map<string, Rotation>();
  /** When each Client was last heard, kept after its session ends so the Clients screen can say "seen 2h ago". */
  readonly #lastHeard = new Map<string, number>();
  /** The Client build of each Client's latest session, kept after the session ends so the version stays observable offline. */
  readonly #lastBuild = new Map<string, string>();
  readonly #options: ConnectionOptions;
  readonly #handshakeTimeoutMs: number;
  readonly #staleMs: number;
  readonly #requestTimeoutMs: number;
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
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? 10_000;
    this.#staleMs = options.staleMs ?? 45_000;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#maxPending = options.maxPendingRequests ?? 1000;
    for (const value of [this.#handshakeTimeoutMs, this.#staleMs, this.#requestTimeoutMs, this.#maxPending]) {
      if (!Number.isFinite(value) || value <= 0) throw new RangeError("invalid connection options");
    }
    this.#now = options.now ?? Date.now;
    this.#schedule = options.schedule ?? realSchedule;
    this.#logger = options.logger ?? NO_LOGGER;
    this.#audit = options.audit ?? NO_AUDIT;
  }

  /** Starts the periodic stale check; stop() ends it. */
  start(): void {
    if (this.#cancelSweep) return;
    const arm = () => {
      this.#cancelSweep = this.#schedule(() => {
        this.sweep();
        arm();
      }, Math.max(1, Math.floor(this.#staleMs / 3)));
    };
    arm();
  }

  stop(): void {
    this.#cancelSweep?.();
    this.#cancelSweep = null;
  }

  /** Takes over a freshly upgraded socket and challenges it. It is unauthenticated until a valid hello is admitted. */
  accept(socket: WebSocket, remoteAddress: string | undefined): void {
    const nonce = newNonce();
    let session: Session | null = null;
    const cancelHandshake = this.#schedule(() => {
      if (!session) socket.terminate();
    }, this.#handshakeTimeoutMs);
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
      session = this.#admit(socket, nonce, remoteAddress, data, isBinary);
      if (session) cancelHandshake();
    });
    socket.send(JSON.stringify({ kind: "challenge", nonce }));
  }

  /** Sends the current full policy snapshot to one connected, enabled Client. */
  syncPolicy(clientId: string): boolean {
    const session = this.#sessions.get(clientId);
    const policies = this.#options.config.effectivePoliciesFor(clientId);
    if (!session || !policies) return false;
    return this.#send(session, { kind: "policy_sync", policies });
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
    if (this.#rotations.has(clientId)) return Promise.resolve("busy");
    const id = this.#newId("rot");
    return new Promise<RotationResult>((resolve) => {
      const settle = (result: RotationResult) => {
        if (!this.#rotations.delete(clientId)) return;
        cancel();
        this.#logger.log(result === "rotated" ? "INFO" : "WARNING", "connections", `key rotation ${result} client_id=${clientId}`);
        this.#audit.record({ actor: "admin", action: "rotate_key", client_id: clientId, result });
        resolve(result);
      };
      const cancel = this.#schedule(() => settle("timeout"), this.#requestTimeoutMs);
      this.#rotations.set(clientId, { id, session, settle, cancel });
      if (!this.#send(session, { kind: "rotate_key", rotation_id: id })) settle("offline");
    });
  }

  /** The build the Client reported on its latest connection, or null when it has never connected since the Server started. */
  lastBuild(clientId: string): string | null {
    return this.#lastBuild.get(clientId) ?? null;
  }

  status(): SessionStatus[] {
    return [...this.#sessions.values()].map((s) => ({ client_id: s.clientId, client_build: s.build, connected_since: s.connectedSince, last_seen: s.lastSeen, online: !this.#isStale(s) }));
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
      }, this.#requestTimeoutMs);
      this.#pending.set(requestId, { session, mutation, settle, cancel });
      if (!this.#send(session, envelope.data)) settle(failureResponse(requestId, this.#lost(mutation, "client is offline")));
    });
  }

  /** The one place a sent request is logged and, if it changes files, audited: exactly once, at its terminal outcome. */
  #recordOutcome(clientId: string, projectId: string, operation: Operation, response: ResponseEnvelope, timedOut: boolean): void {
    const where = `op=${operation.op} client_id=${clientId} project_id=${projectId}`;
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
    return this.#now() - session.lastSeen >= this.#staleMs;
  }

  #send(session: Session, frame: object): boolean {
    if (this.#sessions.get(session.clientId) !== session || session.socket.readyState !== WebSocket.OPEN) return false;
    session.socket.send(JSON.stringify(frame));
    return true;
  }

  #reject(socket: WebSocket, error: WireError, serverBuild?: string): null {
    this.#logger.log("WARNING", "connections", `client refused code=${error.code}`);
    socket.send(JSON.stringify({ kind: "reject", ...(serverBuild ? { server_build: serverBuild } : {}), error }));
    socket.close();
    return null;
  }

  /** Checks the first frame of a socket against its own challenge; returns the new session, or null after refusing it. */
  #admit(socket: WebSocket, nonce: string, remoteAddress: string | undefined, data: WebSocket.RawData, isBinary: boolean): Session | null {
    let frame: unknown;
    try {
      if (isBinary) throw new Error("binary");
      frame = JSON.parse(data.toString());
    } catch {
      return this.#reject(socket, { code: "BAD_REQUEST", message: "invalid handshake frame" });
    }
    const hello = parseWire(ClientHello, frame);
    if (!hello.ok) return this.#reject(socket, hello.error);
    const { client_id: clientId, client_build: build, public_key: publicKey, signature, display_name: displayName, machine_uuid: machineUuid } = hello.data;
    // A registered Client must present a stored key (current or staged) whatever its status; an unknown one proves possession of the key it offers.
    const known = this.#admissionOf(clientId);
    const key = known ? [known.publicKey, known.nextPublicKey].find((k) => k !== null && k === publicKey) : publicKey;
    if (key === undefined || key === null || !verifyChallenge(key, nonce, clientId, signature)) return this.#reject(socket, AUTH_FAILED);
    if (!this.#options.isBuildCompatible(build)) return this.#reject(socket, incompatibleBuildError(build, this.#options.serverBuild), this.#options.serverBuild);
    if (!known) return this.#reject(socket, this.#register(clientId, publicKey, displayName, machineUuid) ? PENDING_APPROVAL : AUTH_FAILED);
    if (!this.#reconcileMachine(clientId, known.machineUuid, machineUuid)) return this.#reject(socket, AUTH_FAILED);
    if (known.status !== "enabled") return this.#reject(socket, known.status === "pending" ? PENDING_APPROVAL : CLIENT_DISABLED);
    if (known.nextPublicKey === publicKey) this.#promoteKey(clientId);
    const existing = this.#sessions.get(clientId);
    if (existing && !this.#isStale(existing)) return this.#reject(socket, { code: "DUPLICATE_CLIENT", message: "client is already connected" });
    if (existing) {
      this.#drop(existing);
      existing.socket.terminate();
    }
    const now = this.#now();
    const session: Session = { clientId, socket, build, connectedSince: now, lastSeen: now };
    this.#sessions.set(clientId, session);
    this.#lastBuild.set(clientId, build);
    this.#logger.log("INFO", "connections", `client connected client_id=${clientId}`);
    this.#send(session, { kind: "welcome", server_build: this.#options.serverBuild, compatible: true });
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
    this.#logger.log("INFO", "connections", `key promoted client_id=${clientId}`);
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
    this.#logger.log("INFO", "connections", `machine_uuid bound client_id=${clientId}`);
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
    this.#logger.log("INFO", "connections", `client registered pending client_id=${clientId}`);
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
    const pending = this.#pending.get(message.data.request_id);
    // A response settles only the request it answers, and only on the session that carried it; anything else is dropped.
    if (pending && pending.session === session) pending.settle(message.data);
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
    this.#lastHeard.set(session.clientId, session.lastSeen);
    this.#rotations.get(session.clientId)?.settle("offline");
    this.#logger.log("INFO", "connections", `client disconnected client_id=${session.clientId}`);
    for (const [id, pending] of [...this.#pending]) {
      if (pending.session === session) pending.settle(failureResponse(id, this.#lost(pending.mutation, "client disconnected")));
    }
  }
}
