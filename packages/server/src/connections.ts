// Live Client sessions on the Server: admission, one active session per client_id, stale detection and request
// routing. Registered Clients, projects and credential digests come only from the config store; nothing a Client says
// about itself adds a project. One Map holds sessions, one Map holds requests awaiting a response, and a response can
// only settle the request that was sent on the same session. A request is never sent twice.
import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import WebSocket from "ws";
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
  type Operation,
  type WireError,
} from "@reach-mcp/shared/wire";
import { bearerCredential, hashCredential, sameDigest } from "./auth.ts";
import { NO_AUDIT, type Audit } from "./audit.ts";
import type { ServerConfigStore } from "./config.ts";
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
  /** How long a caller of route() waits for a response. */
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
type Pending = { session: Session; mutation: boolean; settle: (response: ResponseEnvelope) => void; cancel: () => void };

export type SessionStatus = { client_id: string; client_build: string; connected_since: number; last_seen: number; online: boolean };

const AUTH_FAILED: WireError = { code: "AUTH_FAILED", message: "authentication failed" };

export class ClientConnectionRegistry {
  readonly #sessions = new Map<string, Session>();
  readonly #pending = new Map<string, Pending>();
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

  /** Takes over a freshly upgraded socket. It is unauthenticated until a valid hello is admitted. */
  accept(socket: WebSocket, headers: IncomingHttpHeaders): void {
    const bearer = bearerCredential(headers);
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
      session = this.#admit(socket, bearer, data, isBinary);
      if (session) cancelHandshake();
    });
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
    const requestId = options.requestId ?? `req-${randomUUID()}`;
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

  /** Checks the first frame of a socket; returns the new session, or null after refusing it. */
  #admit(socket: WebSocket, bearer: string | null, data: WebSocket.RawData, isBinary: boolean): Session | null {
    let frame: unknown;
    try {
      if (isBinary) throw new Error("binary");
      frame = JSON.parse(data.toString());
    } catch {
      return this.#reject(socket, { code: "BAD_REQUEST", message: "invalid handshake frame" });
    }
    const hello = parseWire(ClientHello, frame);
    if (!hello.ok) return this.#reject(socket, hello.error);
    const { client_id: clientId, credential, client_build: build } = hello.data;
    const presented = hashCredential(credential);
    let expected: string | null;
    try {
      expected = this.#options.config.credentialDigestFor(clientId);
    } catch {
      expected = null;
    }
    // The header and the hello are two channels for one credential; they must agree before the digest is compared.
    if (bearer === null || !sameDigest(hashCredential(bearer), presented) || expected === null || !sameDigest(presented, expected)) return this.#reject(socket, AUTH_FAILED);
    if (!this.#options.isBuildCompatible(build)) return this.#reject(socket, incompatibleBuildError(build, this.#options.serverBuild), this.#options.serverBuild);
    const existing = this.#sessions.get(clientId);
    if (existing && !this.#isStale(existing)) return this.#reject(socket, { code: "DUPLICATE_CLIENT", message: "client is already connected" });
    if (existing) {
      this.#drop(existing);
      existing.socket.terminate();
    }
    const now = this.#now();
    const session: Session = { clientId, socket, build, connectedSince: now, lastSeen: now };
    this.#sessions.set(clientId, session);
    this.#logger.log("INFO", "connections", `client connected client_id=${clientId}`);
    this.#send(session, { kind: "welcome", server_build: this.#options.serverBuild, compatible: true });
    this.syncPolicy(clientId);
    return session;
  }

  #onResponse(session: Session, data: WebSocket.RawData, isBinary: boolean): void {
    let frame: unknown;
    try {
      if (isBinary) throw new Error("binary");
      frame = JSON.parse(data.toString());
    } catch {
      return session.socket.terminate();
    }
    const response = parseWire(ResponseEnvelope, frame);
    if (!response.ok) return session.socket.terminate();
    const pending = this.#pending.get(response.data.request_id);
    // A response settles only the request it answers, and only on the session that carried it; anything else is dropped.
    if (pending && pending.session === session) pending.settle(response.data);
  }

  /** Forgets a session if it is still the registered one and fails the requests it carried. */
  #drop(session: Session): void {
    if (this.#sessions.get(session.clientId) !== session) return;
    this.#sessions.delete(session.clientId);
    this.#logger.log("INFO", "connections", `client disconnected client_id=${session.clientId}`);
    for (const [id, pending] of [...this.#pending]) {
      if (pending.session === session) pending.settle(failureResponse(id, this.#lost(pending.mutation, "client disconnected")));
    }
  }
}
