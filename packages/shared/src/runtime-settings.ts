// The ONE owner of the mutable runtime knobs: names, canonical defaults, bounds and live-apply behavior. The Server persists them in its
// config (ServerConfigStore) and pushes the Client-side ones over the wire; Client, Server and Admin UI read them from there and never
// carry their own copy of a default. `RUNTIME_KNOBS` is also what the hardcode guard (tests/runtime-guard) checks the sources against.
import { z } from "zod";

type Knob = { default: number; min: number; max: number; unit: "ms" | "ratio"; restart_required: boolean; applies: string; guard: RegExp };

/** Every runtime knob. `restart_required` is true only for a value that cannot change in a running process (none today). */
export const RUNTIME_KNOBS = {
  heartbeat_interval_ms: { default: 30_000, min: 1_000, max: 300_000, unit: "ms", restart_required: false, applies: "Client ping interval; pushed to connected Clients and re-armed", guard: /heartbeat|ping/i },
  stale_ms: { default: 90_000, min: 2_000, max: 900_000, unit: "ms", restart_required: false, applies: "silence after which a session is stale (Server sweep and Client heartbeat)", guard: /stale/i },
  handshake_timeout_ms: { default: 10_000, min: 1_000, max: 120_000, unit: "ms", restart_required: false, applies: "time a new socket has to complete the handshake; read per connection", guard: /handshake/i },
  request_timeout_ms: { default: 30_000, min: 1_000, max: 600_000, unit: "ms", restart_required: false, applies: "time a routed request or key rotation waits for the Client; read per request", guard: /request.?timeout/i },
  reconnect_initial_ms: { default: 1_000, min: 100, max: 60_000, unit: "ms", restart_required: false, applies: "first reconnect delay; read at every retry, pushed to connected Clients", guard: /backoff|reconnect|initialMs/i },
  reconnect_max_ms: { default: 60_000, min: 1_000, max: 3_600_000, unit: "ms", restart_required: false, applies: "longest reconnect delay; read at every retry, pushed to connected Clients", guard: /backoff|reconnect|maxMs/i },
  reconnect_jitter: { default: 0.2, min: 0, max: 1, unit: "ratio", restart_required: false, applies: "fraction a reconnect delay may shrink or grow; read at every retry", guard: /backoff|reconnect|jitter/i },
  admin_autosave_debounce_ms: { default: 500, min: 100, max: 10_000, unit: "ms", restart_required: false, applies: "Admin UI autosave delay; read by the UI from /admin/api/state", guard: /debounce|autosave|setTimeout/i },
} as const satisfies Record<string, Knob>;

export type RuntimeKnob = keyof typeof RUNTIME_KNOBS;

const field = (key: RuntimeKnob) => {
  const { default: value, min, max, unit } = RUNTIME_KNOBS[key];
  return (unit === "ratio" ? z.number() : z.int()).min(min).max(max).default(value);
};

export const RuntimeSettings = z
  .strictObject({
    heartbeat_interval_ms: field("heartbeat_interval_ms"),
    stale_ms: field("stale_ms"),
    handshake_timeout_ms: field("handshake_timeout_ms"),
    request_timeout_ms: field("request_timeout_ms"),
    reconnect_initial_ms: field("reconnect_initial_ms"),
    reconnect_max_ms: field("reconnect_max_ms"),
    reconnect_jitter: field("reconnect_jitter"),
    admin_autosave_debounce_ms: field("admin_autosave_debounce_ms"),
  })
  .superRefine((s, ctx) => {
    if (s.stale_ms <= s.heartbeat_interval_ms) ctx.addIssue({ code: "custom", path: ["stale_ms"], message: "stale_ms must be greater than heartbeat_interval_ms" });
    if (s.reconnect_max_ms < s.reconnect_initial_ms) ctx.addIssue({ code: "custom", path: ["reconnect_max_ms"], message: "reconnect_max_ms must not be below reconnect_initial_ms" });
  });
export type RuntimeSettings = z.infer<typeof RuntimeSettings>;

export const RUNTIME_DEFAULTS: RuntimeSettings = RuntimeSettings.parse({});

/** The part the Client needs; the Server pushes it with the welcome and with every policy snapshot. */
export const ClientRuntime = z.strictObject({
  heartbeat_interval_ms: field("heartbeat_interval_ms"),
  stale_ms: field("stale_ms"),
  reconnect_initial_ms: field("reconnect_initial_ms"),
  reconnect_max_ms: field("reconnect_max_ms"),
  reconnect_jitter: field("reconnect_jitter"),
});
export type ClientRuntime = z.infer<typeof ClientRuntime>;

export const clientRuntimeOf = (s: RuntimeSettings): ClientRuntime => ({
  heartbeat_interval_ms: s.heartbeat_interval_ms,
  stale_ms: s.stale_ms,
  reconnect_initial_ms: s.reconnect_initial_ms,
  reconnect_max_ms: s.reconnect_max_ms,
  reconnect_jitter: s.reconnect_jitter,
});
