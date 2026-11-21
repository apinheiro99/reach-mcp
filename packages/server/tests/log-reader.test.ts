import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuditWriter } from "../src/audit.ts";
import { OperationalLogger } from "../src/logging.ts";
import { RotatingTextWriter } from "../src/rotating-text.ts";
import { readLogs } from "../src/log-reader.ts";

const SETTINGS = () => ({ max_bytes: 1_000_000, retention_days: 5 });
const dirWithLogs = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "reach-logreader-"));
  const clock = (iso: string) => () => new Date(iso);
  const log = (iso: string) => new OperationalLogger(new RotatingTextWriter({ dir, base: "reach", settings: SETTINGS, now: clock(iso) }), clock(iso));
  const audit = (iso: string) => new AuditWriter(new RotatingTextWriter({ dir, base: "audit", settings: SETTINGS, now: clock(iso) }), clock(iso));
  return { dir, log, audit };
};

test("LogReader: normalizes the real operational and audit lines, newest first, without inventing a source", () => {
  const { dir, log, audit } = dirWithLogs();
  log("2026-11-20T10:00:00Z").log("INFO", "connections", "client connected client_id=laptop");
  log("2026-11-20T10:05:00Z").log("WARNING", "connections", "client refused code=AUTH_FAILED");
  log("2026-11-20T10:06:00Z").log("ERROR", "connections", "request timed out op=read client_id=laptop project_id=web", "req-1");
  audit("2026-11-20T10:07:00Z").record({ actor: "admin", action: "client_enable", target: "laptop", result: "ok" });
  audit("2026-11-20T10:08:00Z").record({ actor: "admin", action: "config_edit", result: "refused" });
  const { events, truncated } = readLogs(dir);
  assert.equal(truncated, false);
  assert.deepEqual(events.map((e) => [e.source, e.severity, e.event]), [
    ["audit", "warning", "config_edit"], ["audit", "success", "client_enable"], ["server", "error", "connections: request timed out"], ["server", "warning", "connections: client refused"], ["server", "info", "connections: client connected"]]);
  assert.deepEqual([events[2]!.client, events[2]!.project], ["laptop", "web"]);
  assert.match(events[2]!.details, /request_id=req-1/);
  assert.ok(events.every((e) => e.source === "server" || e.source === "audit"), "there is no tunnel source: nothing logs tunnel events");
});

test("LogReader: reads only canonical regular files; a symlink, a stray file or a directory is never read", () => {
  const { dir, log } = dirWithLogs();
  log("2026-11-20T10:00:00Z").log("INFO", "runtime", "canonical line");
  const outside = path.join(mkdtempSync(path.join(tmpdir(), "reach-outside-")), "secret.log");
  writeFileSync(outside, "2026-11-20T11:00:00Z INFO runtime OUTSIDE-SECRET\n");
  symlinkSync(outside, path.join(dir, "reach-2026-11-19.log"));
  symlinkSync(outside, path.join(dir, "audit.log"));
  writeFileSync(path.join(dir, "notes.log"), "2026-11-20T12:00:00Z INFO runtime STRAY\n");
  mkdirSync(path.join(dir, "reach-2026-11-18.log"));
  const text = JSON.stringify(readLogs(dir));
  assert.ok(text.includes("canonical line"));
  assert.ok(!text.includes("OUTSIDE-SECRET") && !text.includes("STRAY"));
  assert.deepEqual(readLogs(path.join(dir, "missing")), { events: [], truncated: false }, "a missing directory is just empty");
});

test("LogReader: bounded by files, bytes per file and events; a cut first line and malformed lines are dropped", () => {
  const { dir } = dirWithLogs();
  const lines = Array.from({ length: 50 }, (_, i) => `2026-11-20T10:${String(i).padStart(2, "0")}:00Z INFO runtime line-${i}`);
  writeFileSync(path.join(dir, "reach.log"), `${lines.join("\n")}\nnot a log line\n\u0000garbage\n`);
  assert.equal(readLogs(dir, { files: 1, bytesPerFile: 1_000_000, events: 10 }).events.length, 10, "the event cap holds");
  assert.equal(readLogs(dir, { files: 1, bytesPerFile: 1_000_000, events: 10 }).truncated, true);
  const small = readLogs(dir, { files: 1, bytesPerFile: 300, events: 500 });
  assert.ok(small.events.length > 0 && small.events.length < 10, "only the tail of the file is read");
  assert.ok(small.events.every((e) => /^runtime: line-\d+$/.test(e.event)), "a half-read first line never becomes an event");
  writeFileSync(path.join(dir, "reach-2026-11-01.log"), "2026-11-01T00:00:00Z INFO runtime OLD\n");
  writeFileSync(path.join(dir, "reach-2026-11-19.log"), "2026-11-19T00:00:00Z INFO runtime MIDDLE\n");
  const two = JSON.stringify(readLogs(dir, { files: 2, bytesPerFile: 1_000_000, events: 500 }));
  assert.ok(two.includes("MIDDLE") && !two.includes("OLD"), "the newest files are chosen first");
});
