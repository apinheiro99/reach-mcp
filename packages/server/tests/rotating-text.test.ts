import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuditWriter, OperationalLogger, RotatingTextWriter, type LogSettings } from "../src/index.ts";

const fresh = () => mkdtempSync(path.join(tmpdir(), "reach-rot-"));
const at = (iso: string) => new Date(iso);

function writerFor(dir: string, settings: LogSettings, clock: { now: Date }, base = "reach") {
  return new RotatingTextWriter({ dir, base, settings: () => settings, now: () => clock.now });
}

test("operational log line: exact format, one line, no control or ANSI characters", () => {
  const dir = fresh();
  const clock = { now: at("2026-03-04T05:06:07.000Z") };
  const logger = new OperationalLogger(writerFor(dir, { max_bytes: 100_000, retention_days: 5 }, clock), () => clock.now);
  logger.log("INFO", "connections", "client connected client_id=laptop", "req-1");
  logger.log("ERROR", "admin", "line one\nline two\t\x1b[31mred\x1b[0m\r\n");
  const lines = readFileSync(path.join(dir, "reach.log"), "utf8").split("\n");
  assert.equal(lines[0], "2026-03-04T05:06:07.000Z INFO connections request_id=req-1 client connected client_id=laptop");
  assert.equal(lines[1], "2026-03-04T05:06:07.000Z ERROR admin line one line two red");
  assert.equal(lines.length, 3, "two lines and the trailing newline");
  assert.ok([...lines.slice(0, 2).join("")].every((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127), "no control characters");
});

test("audit line: exact compact fields, absent ones omitted, values sanitized", () => {
  const dir = fresh();
  const clock = { now: at("2026-03-04T05:06:07.000Z") };
  const audit = new AuditWriter(writerFor(dir, { max_bytes: 100_000, retention_days: 5 }, clock, "audit"), () => clock.now);
  audit.record({ actor: "chatgpt", action: "fs_write", client_id: "laptop", project_id: "web", target: "src/a\nb.ts", request_id: "req-9", result: "ok" });
  audit.record({ actor: "admin", action: "config_edit", result: "refused" });
  assert.equal(
    readFileSync(path.join(dir, "audit.log"), "utf8"),
    "2026-03-04T05:06:07.000Z\tactor=chatgpt\taction=fs_write\tclient_id=laptop\tproject_id=web\ttarget=src/a b.ts\trequest_id=req-9\tresult=ok\n" +
      "2026-03-04T05:06:07.000Z\tactor=admin\taction=config_edit\tresult=refused\n",
  );
});

test("size rotation happens before the append that would pass the limit, and same-day rotations never collide", () => {
  const dir = fresh();
  const clock = { now: at("2026-03-04T10:00:00") };
  const w = writerFor(dir, { max_bytes: 30, retention_days: 5 }, clock);
  for (const line of ["a".repeat(19), "b".repeat(19), "c".repeat(19), "d".repeat(19)]) w.write(line); // each is 20 bytes with its newline
  assert.deepEqual(readdirSync(dir).sort(), ["reach-2026-03-04-1.log", "reach-2026-03-04-2.log", "reach-2026-03-04.log", "reach.log"]);
  assert.equal(readFileSync(path.join(dir, "reach.log"), "utf8"), `${"d".repeat(19)}\n`);
  assert.equal(readFileSync(path.join(dir, "reach-2026-03-04.log"), "utf8"), `${"a".repeat(19)}\n`);
  for (const name of readdirSync(dir)) assert.ok(readFileSync(path.join(dir, name)).length <= 30, `${name} stays within the limit`);
});

test("date change rotates on the first later write and names the file by the day it holds", () => {
  const dir = fresh();
  const clock = { now: at("2026-03-04T23:59:00") };
  const w = writerFor(dir, { max_bytes: 100_000, retention_days: 5 }, clock);
  w.write("late");
  clock.now = at("2026-03-05T00:00:30");
  w.write("early");
  assert.equal(readFileSync(path.join(dir, "reach-2026-03-04.log"), "utf8"), "late\n");
  assert.equal(readFileSync(path.join(dir, "reach.log"), "utf8"), "early\n");
});

test("retention removes only this writer's old regular rotated files; symlinks, directories and other names are untouched", () => {
  const dir = fresh();
  const outside = path.join(fresh(), "precious.txt");
  writeFileSync(outside, "keep me");
  for (const name of ["reach-2026-01-01.log", "reach-2026-01-04-3.log", "reach-2026-01-05.log", "reach-2026-01-09.log", "notes.txt", "reach-2026-01-01.log.bak", "other-2026-01-01.log", "reach.log.1"]) writeFileSync(path.join(dir, name), "x");
  symlinkSync(outside, path.join(dir, "reach-2026-01-02.log"));
  mkdirSync(path.join(dir, "reach-2026-01-03.log"));
  const clock = { now: at("2026-01-10T12:00:00") };
  writerFor(dir, { max_bytes: 100_000, retention_days: 5 }, clock).write("now");
  assert.deepEqual(
    readdirSync(dir).sort(),
    ["notes.txt", "other-2026-01-01.log", "reach-2026-01-01.log.bak", "reach-2026-01-02.log", "reach-2026-01-03.log", "reach-2026-01-05.log", "reach-2026-01-09.log", "reach.log", "reach.log.1"],
  );
  assert.equal(readFileSync(outside, "utf8"), "keep me", "a symlink target is never followed");
});

test("retention days are taken from the current settings; a failing directory never throws", () => {
  const dir = fresh();
  writeFileSync(path.join(dir, "reach-2026-01-08.log"), "x");
  const settings = { max_bytes: 100_000, retention_days: 5 };
  const clock = { now: at("2026-01-10T12:00:00") };
  const w = writerFor(dir, settings, clock);
  w.write("one");
  assert.ok(existsSync(path.join(dir, "reach-2026-01-08.log")));
  settings.retention_days = 1;
  clock.now = at("2026-01-11T12:00:00");
  w.write("two");
  assert.ok(!existsSync(path.join(dir, "reach-2026-01-08.log")));
  const blocked = path.join(dir, "reach.log"); // a file where the directory should be
  assert.equal(writerFor(path.join(blocked, "sub"), settings, clock).write("x"), false);
});

test("the active file is never a followed symlink or other non-regular object, for the log and the audit", () => {
  const dir = fresh();
  const outside = path.join(fresh(), "outside.txt");
  writeFileSync(outside, "untouched");
  const clock = { now: at("2026-03-04T10:00:00") };
  const settings = { max_bytes: 100_000, retention_days: 5 };
  for (const base of ["reach", "audit"]) {
    symlinkSync(outside, path.join(dir, `${base}.log`));
    assert.equal(writerFor(dir, settings, clock, base).write("must not land outside"), false, `${base}: live symlink`);
  }
  assert.equal(readFileSync(outside, "utf8"), "untouched");
  const dangling = fresh();
  symlinkSync(path.join(dangling, "missing-target"), path.join(dangling, "reach.log"));
  assert.equal(writerFor(dangling, settings, clock).write("x"), false, "a dangling symlink is refused too");
  assert.ok(!existsSync(path.join(dangling, "missing-target")), "the target was never created");
  const asDir = fresh();
  mkdirSync(path.join(asDir, "reach.log"));
  assert.equal(writerFor(asDir, settings, clock).write("x"), false, "a directory is refused");
  assert.deepEqual(readdirSync(dir).sort(), ["audit.log", "reach.log"], "nothing was renamed or removed");
});

test("a single line larger than max_bytes is refused whole: nothing is created, enlarged or rotated", () => {
  const dir = fresh();
  const clock = { now: at("2026-03-04T10:00:00") };
  const settings = { max_bytes: 1024, retention_days: 5 };
  const w = writerFor(dir, settings, clock);
  assert.equal(w.write("x".repeat(1024)), false, "the line plus its newline is 1025 bytes");
  assert.deepEqual(readdirSync(dir), [], "no file was created");
  assert.equal(w.write("y".repeat(1023)), true, "exactly the limit is allowed");
  assert.equal(w.write("z".repeat(2000)), false);
  assert.deepEqual(readdirSync(dir), ["reach.log"], "no rotation was triggered by the refused line");
  assert.equal(readFileSync(path.join(dir, "reach.log"), "utf8"), `${"y".repeat(1023)}\n`);
});

test("one rotation implementation serves both writers; no logging framework or global exists", () => {
  const src = path.join(import.meta.dirname, "..", "src");
  const read = (f: string) => readFileSync(path.join(src, f), "utf8");
  for (const f of ["logging.ts", "audit.ts"]) assert.ok(!/renameSync|unlinkSync|appendFileSync|readdirSync|node:fs/.test(read(f)), `${f} holds no file mechanics`);
  assert.equal((read("rotating-text.ts").match(/renameSync\(/g) ?? []).length, 1);
  const all = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts")).map(read).join("\n");
  assert.ok(!/console\.(log|error|warn)|EventEmitter|winston|pino|prom-client|opentelemetry/.test(all), "no console logger, event bus or framework");
  const pkg = readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8");
  assert.ok(!/winston|pino|bunyan|prom-client|opentelemetry/.test(pkg));
});
