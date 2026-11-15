// Literal-by-default search, bounded regex, budgets and the no-oracle guarantees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FilesystemReader, REDACTED } from "../src/filesystem/index.ts";
import { code, LIMITS, makeFixture } from "./fixture.ts";

const { root } = makeFixture();
const reader = new FilesystemReader({ root, limits: LIMITS });

test("search: known symbol, file and line, case-insensitive by default", () => {
  const out = reader.search({ patterns: ["ANSWER"] });
  assert.deepEqual(out.matches.map((m) => [m.path, m.line]), [["src/app.ts", 1]]);
  assert.equal(out.summary[0]?.matches, 1);
  assert.equal(out.truncated, false);
  assert.equal(reader.search({ patterns: ["ANSWER"], caseSensitive: true }).matches.length, 0);
});

test("search: finds an unknown file by content", () => {
  assert.deepEqual(reader.search({ patterns: ["TOKEN_FLOW"] }).matches.map((m) => m.path), ["docs/Guide.md"]);
});

test("search: several patterns in one call, with per-pattern counts and no-match honesty", () => {
  const out = reader.search({ patterns: ["export", "hello", "nothing-like-this"] });
  const byPattern = Object.fromEntries(out.summary.map((s) => [s.pattern, s.matches]));
  assert.ok((byPattern["export"] as number) >= 3);
  assert.equal(byPattern["hello"], 1);
  assert.equal(byPattern["nothing-like-this"], 0);
});

test("search: context lines, include/exclude and path scope", () => {
  const ctx = reader.search({ patterns: ["greet"], contextLines: 1, path: "src" });
  const hit = ctx.matches.find((m) => m.line === 2);
  assert.ok(hit);
  assert.deepEqual(hit.before, ["export const answer = 42;"]);
  assert.equal(hit.after?.length, 1);
  assert.equal(reader.search({ patterns: ["export"], include: ["*.md"] }).matches.length, 0);
  assert.ok(reader.search({ patterns: ["export"], include: ["src/**"] }).matches.length > 0);
  assert.equal(reader.search({ patterns: ["export"], exclude: ["src/**"] }).matches.length, 0);
  assert.equal(reader.search({ patterns: ["export"], path: "src/app.ts" }).matches.length, 2, "a single file is a valid scope");
});

test("search: text is the default and regex characters are literal", () => {
  assert.equal(reader.search({ patterns: ["answer\\s*=\\s*\\d+"] }).matches.length, 0, "regex syntax in text mode matches nothing");
  assert.equal(reader.search({ patterns: ["(a+)+$"], mode: "text" }).matches.length, 0, "text mode treats it literally");
  assert.equal(reader.search({ patterns: ["answer\\s*=\\s*\\d+"], mode: "regex" }).matches.length, 1, "regex mode is explicit");
});

test("search: invalid, unsafe and over-limit patterns are refused", () => {
  assert.equal(code(() => reader.search({ patterns: ["("], mode: "regex" })), "INVALID_ARGUMENT");
  assert.equal(code(() => reader.search({ patterns: ["(a+)+$"], mode: "regex" })), "INVALID_ARGUMENT");
  assert.equal(code(() => reader.search({ patterns: ["(.*)*x"], mode: "regex" })), "INVALID_ARGUMENT");
  assert.equal(code(() => reader.search({ patterns: [] })), "INVALID_ARGUMENT");
  assert.equal(code(() => reader.search({ patterns: [""] })), "INVALID_ARGUMENT");
  assert.equal(code(() => reader.search({ patterns: Array.from({ length: 11 }, (_, i) => `p${i}`) })), "INVALID_ARGUMENT");
  assert.equal(code(() => reader.search({ patterns: ["x".repeat(201)] })), "INVALID_ARGUMENT");
});

test("search: results are bounded, shared between patterns, and truncation is reported", () => {
  const out = reader.search({ patterns: ["line", "line 1"], path: "lines.txt" });
  assert.ok(out.matches.filter((m) => m.pattern === "line").length <= 2);
  assert.equal(out.summary[0]?.matches, 30, "counts keep counting past the cap");
  assert.equal(out.truncated, true);
  assert.equal(out.stoppedBy, "results");
  assert.ok(out.matches.some((m) => m.pattern === "line 1"), "second pattern is not starved");
});

test("search: file and byte budgets stop the scan and say so", () => {
  const files = new FilesystemReader({ root, limits: { ...LIMITS, maxSearchFiles: 1 } });
  const byFiles = files.search({ patterns: ["e"] });
  assert.equal(byFiles.stoppedBy, "files");
  assert.equal(byFiles.truncated, true);
  const bytes = new FilesystemReader({ root, limits: { ...LIMITS, maxSearchBytes: 1 } });
  assert.equal(bytes.search({ patterns: ["e"] }).stoppedBy, "bytes");
});

test("search: long lines are matched on a prefix only", () => {
  const { root: dir } = makeFixture();
  writeFileSync(path.join(dir, "long.txt"), `${"a".repeat(600)}needle\n`);
  const r = new FilesystemReader({ root: dir, limits: { maxLineChars: 500 } });
  assert.equal(r.search({ patterns: ["needle"] }).matches.length, 0, "the match is beyond the prefix");
});

test("search: never returns content from secrets, symlinks, binaries or oversized files", () => {
  for (const needle of ["not-a-real-value", "other-value", "pem placeholder", "outside data", "host entry"]) {
    assert.equal(reader.search({ patterns: [needle] }).matches.length, 0, `${needle} must not be searchable`);
  }
  const big = reader.search({ patterns: ["xxxx"] });
  assert.equal(big.matches.length, 0);
  assert.ok(big.filesSkipped.tooLarge >= 1);
  assert.ok(reader.search({ patterns: ["zzzz"] }).filesSkipped.binary >= 1);
  assert.equal(code(() => reader.search({ patterns: ["a"], path: ".env" })), "DENIED");
});

test("search: no oracle for secret values and key-material files are skipped and counted", () => {
  const { root: dir } = makeFixture();
  const key = "-----BEGIN " + "RSA PRIVATE KEY" + "-----\nMIIEowIBAAKCAQEA\n-----END " + "RSA PRIVATE KEY" + "-----\n";
  writeFileSync(path.join(dir, "notes.txt"), key);
  writeFileSync(path.join(dir, "settings.txt"), "DB_PASS" + "WORD=s3cr3t-value-here\n");
  const r = new FilesystemReader({ root: dir, limits: LIMITS });
  assert.equal(r.search({ patterns: ["s3cr3t-value-here"] }).matches.length, 0, "the value is not searchable");
  const byName = r.search({ patterns: ["DB_PASS" + "WORD"] });
  assert.equal(byName.matches.length, 1);
  assert.equal(byName.matches[0]?.text, `DB_PASS` + `WORD=${REDACTED}`);
  const found = r.search({ patterns: ["MIIEowIBAAKCAQEA", "PRIVATE KEY"] });
  assert.equal(found.matches.length, 0);
  assert.equal(found.filesSkipped.secretContent, 1);
});

test("search: node_modules is skipped and symlinks are not followed", () => {
  assert.equal(reader.search({ patterns: ["module.exports"] }).matches.length, 0);
  assert.deepEqual(reader.search({ patterns: ["greet"] }).matches.map((m) => m.path).sort(), ["src/app.ts"], "the link to app.ts is not scanned twice");
});

test("search: the result cap holds even when the limit is below the number of patterns", () => {
  const out = reader.search({ patterns: ["export", "hello", "line"], limit: 2 });
  assert.ok(out.matches.length <= 2, "never more matches than the limit");
  assert.deepEqual(out.matches.map((m) => m.pattern).sort(), ["export", "hello"], "the first patterns get the shares, deterministically");
  assert.equal(out.truncated, true);
  assert.equal(out.stoppedBy, "results");
});

test("search: binary and key-material candidates consume the file budget", () => {
  const { root: dir } = makeFixture();
  mkdirSync(path.join(dir, "probe"));
  const key = "-----BEGIN " + "RSA PRIVATE KEY" + "-----\nabc\n-----END " + "RSA PRIVATE KEY" + "-----\n";
  writeFileSync(path.join(dir, "probe", "a1.bin"), Buffer.from([0, 1, 2]));
  writeFileSync(path.join(dir, "probe", "a2.txt"), key);
  writeFileSync(path.join(dir, "probe", "a3.txt"), "needle\n");
  const r = new FilesystemReader({ root: dir, limits: { ...LIMITS, maxSearchFiles: 2 } });
  const out = r.search({ patterns: ["needle"], path: "probe" });
  assert.equal(out.stoppedBy, "files");
  assert.equal(out.matches.length, 0, "the third candidate is never opened");
  assert.equal(out.filesScanned, 2);
  assert.equal(out.filesSkipped.binary + out.filesSkipped.secretContent, 2);
});

test("search: a candidate that would cross the byte budget is not read", () => {
  const { root: dir } = makeFixture();
  mkdirSync(path.join(dir, "probe"));
  writeFileSync(path.join(dir, "probe", "a1.txt"), "needle one\n");
  writeFileSync(path.join(dir, "probe", "a2.txt"), "needle two\n");
  const r = new FilesystemReader({ root: dir, limits: { ...LIMITS, maxSearchBytes: 15 } });
  const out = r.search({ patterns: ["needle"], path: "probe" });
  assert.equal(out.stoppedBy, "bytes");
  assert.deepEqual(out.matches.map((m) => m.path), ["probe/a1.txt"], "the second file would reach 22 bytes, so it stays closed");
  assert.equal(out.filesScanned, 1);
});
