import { test } from "node:test";
import assert from "node:assert/strict";
import { clientRuntimeOf, RUNTIME_DEFAULTS, RUNTIME_KNOBS, RuntimeSettings } from "../src/runtime-settings.ts";

test("canonical defaults: heartbeat 30s, stale 90s, handshake 10s, request 30s, reconnect 1s..60s with 0.2 jitter, autosave 500ms", () => {
  assert.deepEqual(RUNTIME_DEFAULTS, { heartbeat_interval_ms: 30_000, stale_ms: 90_000, handshake_timeout_ms: 10_000, request_timeout_ms: 30_000, reconnect_initial_ms: 1_000, reconnect_max_ms: 60_000, reconnect_jitter: 0.2, admin_autosave_debounce_ms: 500 });
  assert.deepEqual(RuntimeSettings.parse({}), RUNTIME_DEFAULTS, "an absent override is the canonical default, never a component fallback");
});

test("the knob table is the schema: every knob has a default inside its own bounds, no knob needs a restart, and the bounds are enforced", () => {
  assert.deepEqual(Object.keys(RUNTIME_KNOBS).sort(), Object.keys(RUNTIME_DEFAULTS).sort());
  for (const [key, knob] of Object.entries(RUNTIME_KNOBS)) {
    assert.ok(knob.default >= knob.min && knob.default <= knob.max, key);
    assert.equal(knob.restart_required, false, `${key} applies live`);
    assert.equal(RuntimeSettings.safeParse({ [key]: knob.min - 1 }).success, false, `${key} below min`);
    assert.equal(RuntimeSettings.safeParse({ [key]: knob.max + 1 }).success, false, `${key} above max`);
  }
});

test("invalid combinations and unknown fields are refused without echoing the input", () => {
  assert.equal(RuntimeSettings.safeParse({ heartbeat_interval_ms: 30_000, stale_ms: 30_000 }).success, false, "stale must exceed the heartbeat");
  assert.equal(RuntimeSettings.safeParse({ reconnect_initial_ms: 5_000, reconnect_max_ms: 1_000 }).success, false);
  assert.equal(RuntimeSettings.safeParse({ heartbeat_interval_ms: 1.5 }).success, false, "whole milliseconds");
  const leak = RuntimeSettings.safeParse({ secret_marker: "leak-marker-Zq41" });
  assert.equal(leak.success, false);
  assert.ok(!JSON.stringify(leak.error?.issues.map((i) => i.message)).includes("leak-marker-Zq41"));
});

test("clientRuntimeOf carries exactly the five Client-side knobs", () => {
  assert.deepEqual(Object.keys(clientRuntimeOf(RUNTIME_DEFAULTS)).sort(), ["heartbeat_interval_ms", "reconnect_initial_ms", "reconnect_jitter", "reconnect_max_ms", "stale_ms"]);
});
