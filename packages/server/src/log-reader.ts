// The one bounded reader of the existing operational log (`reach*.log`) and audit trail (`audit*.log`), for the Logs screen. It writes
// nothing and keeps no index: every call reads the tail of a few canonical regular files under the configured log directory, never
// follows a symlink and never opens any other path, then normalizes the lines the two writers already produce (logging.ts, audit.ts).
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import path from "node:path";

export type LogSource = "server" | "audit";
export type LogSeverity = "info" | "success" | "warning" | "error";
export type LogEvent = { time: string; source: LogSource; severity: LogSeverity; event: string; client: string | null; project: string | null; details: string };
export type LogLimits = { files: number; bytesPerFile: number; events: number };
export const DEFAULT_LOG_LIMITS: LogLimits = { files: 6, bytesPerFile: 256 * 1024, events: 500 };

const CANONICAL = /^(reach|audit)(?:-\d{4}-\d{2}-\d{2}(?:-\d+)?)?\.log$/;
const FIELD = 300;
const OPERATIONAL = /^(\S+) (DEBUG|INFO|WARNING|ERROR|CRITICAL) (\S+)(?: request_id=(\S+))? ?(.*)$/;
const SEVERITY: Record<string, LogSeverity> = { DEBUG: "info", INFO: "info", WARNING: "warning", ERROR: "error", CRITICAL: "error" };

const clip = (value: string): string => value.slice(0, FIELD);
const valueOf = (message: string, key: string): string | null => new RegExp(`(?:^| )${key}=(\\S+)`).exec(message)?.[1] ?? null;

/** One line of the operational log, or null when it is not in the writer's format. */
function parseOperational(line: string): LogEvent | null {
  const m = OPERATIONAL.exec(line);
  if (!m || Number.isNaN(Date.parse(m[1] as string))) return null;
  const message = m[5] as string;
  return {
    time: m[1] as string,
    source: "server",
    severity: SEVERITY[m[2] as string] as LogSeverity,
    event: clip(`${m[3]}: ${message.split(" ").filter((w) => !w.includes("=")).join(" ")}`.trim()),
    client: valueOf(message, "client_id"),
    project: valueOf(message, "project_id"),
    details: clip(m[4] ? `${message} request_id=${m[4]}` : message),
  };
}

/** One line of the audit trail: an ISO time then tab-separated key=value pairs. */
function parseAudit(line: string): LogEvent | null {
  const [time, ...pairs] = line.split("\t");
  if (!time || Number.isNaN(Date.parse(time))) return null;
  const field = new Map(pairs.flatMap((p) => (p.includes("=") ? [[p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)] as const] : [])));
  const result = field.get("result") ?? "";
  return {
    time,
    source: "audit",
    severity: result === "ok" ? "success" : "warning",
    event: clip(field.get("action") ?? "audit"),
    client: field.get("client_id") ?? null,
    project: field.get("project_id") ?? null,
    details: clip([field.get("actor") ? `actor=${field.get("actor")}` : "", field.get("target") ? `target=${field.get("target")}` : "", result ? `result=${result}` : ""].filter(Boolean).join(" ")),
  };
}

/** The last `bytes` of one canonical regular file; null for anything else (symlink, directory, vanished). Never follows a link. */
function tail(file: string, bytes: number): string | null {
  try {
    if (!lstatSync(file).isFile()) return null;
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, bytes);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      const text = buffer.toString("utf8");
      return size > bytes ? text.slice(text.indexOf("\n") + 1) : text; // a cut first line is dropped
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Newest files first: the active file, then rotated ones by date and suffix, most recent first. */
const newestFirst = (a: string, b: string): number => (a.includes("-") === b.includes("-") ? (a < b ? 1 : -1) : a.includes("-") ? 1 : -1);

/** The newest events of both logs, newest first and bounded: files, bytes per file and events are all capped. */
export function readLogs(dir: string, limits: LogLimits = DEFAULT_LOG_LIMITS): { events: LogEvent[]; truncated: boolean } {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => CANONICAL.test(n));
  } catch {
    return { events: [], truncated: false };
  }
  const chosen = (["reach", "audit"] as const).flatMap((base) => names.filter((n) => n.startsWith(`${base}.`) || n.startsWith(`${base}-`)).sort(newestFirst).slice(0, limits.files));
  const events: LogEvent[] = [];
  for (const name of chosen) {
    const text = tail(path.join(dir, name), limits.bytesPerFile);
    if (text === null) continue;
    const parse = name.startsWith("audit") ? parseAudit : parseOperational;
    for (const line of text.split("\n")) {
      const event = line ? parse(line) : null;
      if (event) events.push(event);
    }
  }
  events.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  return { events: events.slice(0, limits.events), truncated: events.length > limits.events };
}
