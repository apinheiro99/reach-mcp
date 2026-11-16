// The Client's outbound connection lifecycle. The Client always dials out; the Server alone decides admission,
// build compatibility and one-active-identity, so a rejection is only ever obeyed, never second-guessed or worked around.
// Liveness uses ws ping/pong control frames. The credential travels in the upgrade Authorization header and in the typed
// hello, never in the URL, and no state, error or log value built here contains it.
import WebSocket from "ws";
import type { RawData } from "ws";
import { ClientHello, HandshakeReply, parseWire, PostWelcomeMessage, type PolicySync, type RequestEnvelope, type ResponseEnvelope, type WireError } from "@reach-mcp/shared/wire";
import type { Bootstrap } from "./bootstrap.ts";
import { realSchedule, type Schedule } from "@reach-mcp/shared/timers";

export type TransportState = "stopped" | "connecting" | "handshaking" | "connected" | "backoff" | "terminal_error";

/** Admission outcomes that need an operator or configuration change: retrying cannot help and must not displace anyone. */
const TERMINAL_REJECTS: ReadonlySet<string> = new Set(["AUTH_FAILED", "DUPLICATE_CLIENT", "INCOMPATIBLE_BUILD"]);

/** What the transport hands admitted traffic to; the dispatcher implements it. */
export type FrameHandler = {
  /** Throws when the snapshot is refused; the previous snapshot must then stay active. */
  applyPolicy(frame: PolicySync): void;
  /** Resolves with exactly one response for the request. */
  handle(request: RequestEnvelope): Promise<ResponseEnvelope>;
};

export type TransportOptions = {
  /** Receives policy snapshots and requests after the welcome; without one, any such frame fails closed. */
  handler?: FrameHandler;
  /** Opaque build identifier of this Client, sent as-is in the hello. */
  build: string;
  /** Delays in ms; `jitter` is the fraction (0..1) a delay may shrink or grow. */
  backoff?: { initialMs: number; maxMs: number; jitter: number };
  /** Ping every `intervalMs`; the connection is stale when nothing came back for `staleMs`. */
  heartbeat?: { intervalMs: number; staleMs: number };
  /** Longest a connected socket may stay without a welcome or reject; pongs never extend it. */
  handshakeTimeoutMs?: number;
  /** Test seams: all default to the real clock, real timers, Math.random and a real ws socket. */
  now?: () => number;
  schedule?: Schedule;
  random?: () => number;
  createSocket?: (url: string, headers: Record<string, string>) => WebSocket;
};

const DEFAULT_BACKOFF = { initialMs: 1000, maxMs: 60_000, jitter: 0.2 };
const DEFAULT_HEARTBEAT = { intervalMs: 15_000, staleMs: 45_000 };
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

const positive = (value: number): boolean => Number.isFinite(value) && value > 0;

/** Refuses timing values that would schedule pathological timers. */
function validateTiming(backoff: { initialMs: number; maxMs: number; jitter: number }, heartbeat: { intervalMs: number; staleMs: number }, handshakeMs: number): void {
  const ok = positive(backoff.initialMs) && positive(backoff.maxMs) && backoff.maxMs >= backoff.initialMs && backoff.jitter >= 0 && backoff.jitter <= 1 && positive(heartbeat.intervalMs) && positive(heartbeat.staleMs) && positive(handshakeMs);
  if (!ok) throw new RangeError("invalid transport timing options");
}

const connectionLost: WireError = { code: "INTERNAL", message: "connection lost" };

export class ClientTransport {
  #state: TransportState = "stopped";
  #lastError: WireError | null = null;
  #lastHealthyAt: number | null = null;
  #attempts = 0;
  #socket: WebSocket | null = null;
  #cancelRetry: (() => void) | null = null;
  #cancelHeartbeat: (() => void) | null = null;
  #cancelHandshake: (() => void) | null = null;
  readonly #bootstrap: Bootstrap;
  readonly #build: string;
  readonly #backoff: { initialMs: number; maxMs: number; jitter: number };
  readonly #heartbeat: { intervalMs: number; staleMs: number };
  readonly #handshakeTimeoutMs: number;
  readonly #handler: FrameHandler | undefined;
  readonly #now: () => number;
  readonly #schedule: Schedule;
  readonly #random: () => number;
  readonly #createSocket: (url: string, headers: Record<string, string>) => WebSocket;

  constructor(bootstrap: Bootstrap, options: TransportOptions) {
    this.#bootstrap = bootstrap;
    this.#build = options.build;
    this.#backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.#heartbeat = options.heartbeat ?? DEFAULT_HEARTBEAT;
    this.#handler = options.handler;
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    validateTiming(this.#backoff, this.#heartbeat, this.#handshakeTimeoutMs);
    this.#now = options.now ?? Date.now;
    this.#schedule = options.schedule ?? realSchedule;
    this.#random = options.random ?? Math.random;
    this.#createSocket = options.createSocket ?? ((url, headers) => new WebSocket(url, { headers, perMessageDeflate: false }));
  }

  /** Safe observable state: no credential and no socket internals. */
  snapshot(): { state: TransportState; lastError: WireError | null; lastHealthyAt: number | null; attempts: number } {
    return { state: this.#state, lastError: this.#lastError, lastHealthyAt: this.#lastHealthyAt, attempts: this.#attempts };
  }

  /** Starts the lifecycle; a second call while running, backing off or terminal creates nothing. */
  start(): void {
    if (this.#state !== "stopped") return;
    this.#connect();
  }

  stop(): void {
    this.#cancelRetry?.();
    this.#cancelRetry = null;
    this.#stopHeartbeat();
    this.#stopHandshake();
    const socket = this.#socket;
    this.#socket = null;
    this.#state = "stopped";
    socket?.terminate();
  }

  #connect(): void {
    this.#state = "connecting";
    const socket = this.#createSocket(this.#bootstrap.endpoint, { Authorization: `Bearer ${this.#bootstrap.credential()}` });
    this.#socket = socket;
    socket.on("open", () => this.#onOpen(socket));
    socket.on("message", (data, isBinary) => this.#onMessage(socket, data, isBinary));
    socket.on("pong", () => this.#onPong(socket));
    socket.on("close", () => this.#onDown(socket));
    socket.on("error", () => undefined); // the close event follows and drives the lifecycle; the error text is never kept
  }

  #onOpen(socket: WebSocket): void {
    if (socket !== this.#socket) return;
    this.#state = "handshaking";
    this.#lastHealthyAt = this.#now();
    const hello = ClientHello.parse({ kind: "hello", client_id: this.#bootstrap.clientId, credential: this.#bootstrap.credential(), client_build: this.#build });
    socket.send(JSON.stringify(hello));
    this.#armHeartbeat(socket);
    this.#cancelHandshake = this.#schedule(() => {
      this.#cancelHandshake = null;
      if (socket !== this.#socket || this.#state !== "handshaking") return;
      this.#lastError = { code: "INTERNAL", message: "handshake timed out" };
      socket.terminate();
    }, this.#handshakeTimeoutMs);
  }

  #onMessage(socket: WebSocket, data: RawData, isBinary: boolean): void {
    if (socket !== this.#socket) return;
    let frame: unknown;
    try {
      if (isBinary) throw new Error("binary");
      frame = JSON.parse(data.toString());
    } catch {
      return this.#failClosed(socket, "malformed frame");
    }
    if (this.#state === "connected") return this.#onAdmittedFrame(socket, frame);
    if (this.#state !== "handshaking") return;
    const reply = parseWire(HandshakeReply, frame);
    if (!reply.ok) return this.#failClosed(socket, "invalid handshake reply");
    this.#stopHandshake();
    if (reply.data.kind === "welcome") {
      this.#state = "connected";
      this.#attempts = 0;
      this.#lastError = null;
      this.#lastHealthyAt = this.#now();
      return;
    }
    this.#lastError = reply.data.error;
    if (TERMINAL_REJECTS.has(reply.data.error.code)) {
      this.#stopHeartbeat();
      this.#state = "terminal_error";
      this.#socket = null;
      socket.terminate();
    } else {
      socket.terminate();
    }
  }

  /** After the welcome only a policy snapshot or a request is legal; anything else closes the socket. */
  #onAdmittedFrame(socket: WebSocket, frame: unknown): void {
    const message = this.#handler ? parseWire(PostWelcomeMessage, frame) : null;
    if (!this.#handler || !message?.ok) return this.#failClosed(socket, "unexpected frame after the handshake");
    if (message.data.kind === "policy_sync") {
      try {
        this.#handler.applyPolicy(message.data);
      } catch {
        // No acknowledgement frame exists, so a snapshot that cannot be applied would leave Server and Client silently
        // apart: drop the connection (the last good snapshot stays active) and let the Server resend after reconnect.
        this.#failClosed(socket, "policy snapshot refused");
      }
      return;
    }
    this.#handler.handle(message.data).then(
      (response) => {
        // A late result belongs to the connection that asked; it is never replayed on a newer one.
        if (socket === this.#socket && this.#state === "connected") socket.send(JSON.stringify(response));
      },
      () => this.#failClosed(socket, "request handler failed"),
    );
  }

  #onPong(socket: WebSocket): void {
    if (socket === this.#socket) this.#lastHealthyAt = this.#now();
  }

  /** A protocol violation closes the socket and is retried like any transport failure, with a fixed non-echoing error. */
  #failClosed(socket: WebSocket, reason: string): void {
    this.#lastError = { code: "BAD_REQUEST", message: reason };
    socket.terminate();
  }

  #onDown(socket: WebSocket): void {
    if (socket !== this.#socket) return;
    this.#socket = null;
    this.#stopHeartbeat();
    this.#stopHandshake();
    if (!this.#lastError) this.#lastError = connectionLost;
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#cancelRetry) return;
    const { initialMs, maxMs, jitter } = this.#backoff;
    const base = Math.min(maxMs, initialMs * 2 ** this.#attempts);
    const delay = Math.min(maxMs, Math.max(0, Math.round(base * (1 + jitter * (this.#random() * 2 - 1)))));
    this.#attempts += 1;
    this.#state = "backoff";
    this.#cancelRetry = this.#schedule(() => {
      this.#cancelRetry = null;
      this.#connect();
    }, delay);
  }

  #armHeartbeat(socket: WebSocket): void {
    this.#cancelHeartbeat = this.#schedule(() => {
      if (socket !== this.#socket) return;
      const silent = this.#now() - (this.#lastHealthyAt ?? 0);
      if (silent >= this.#heartbeat.staleMs) {
        this.#lastError = { code: "INTERNAL", message: "connection stale" };
        socket.terminate();
        return;
      }
      socket.ping();
      this.#armHeartbeat(socket);
    }, this.#heartbeat.intervalMs);
  }

  #stopHandshake(): void {
    this.#cancelHandshake?.();
    this.#cancelHandshake = null;
  }

  #stopHeartbeat(): void {
    this.#cancelHeartbeat?.();
    this.#cancelHeartbeat = null;
  }
}
