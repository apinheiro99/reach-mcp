// Confinement, deny, bounded list/find/read and symlink behaviour on a real temporary tree.
import { test } from "node:test";
import assert from "node:assert/strict";
import { symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FilesystemReader, REDACTED } from "../src/filesystem/index.ts";
import { code, LIMITS, makeFixture } from "./fixture.ts";

const { root } = makeFixture();
const reader = new FilesystemReader({ root, limits: LIMITS });

test("list: root, subdirectory, depth, ordering and skipped noise", () => {
  const top = reader.list("");
  const names = top.entries.map((e) => e.path);
  assert.ok(names.includes("README.md") && names.includes("src") && names.includes("docs"));
  assert.equal(top.entries.find((e) => e.path === "src")?.size, undefined, "dirs have no size");
  assert.deepEqual(names, [...names].sort(), "sorted");
  const deep = reader.list("src", 2).entries.map((e) => e.path);
  assert.ok(deep.includes("src/app.ts") && deep.includes("src/lib/util.ts"));
  assert.ok(!reader.list("", 3).entries.some((e) => e.path.startsWith("node_modules/pkg")), "node_modules is not expanded");
});

test("list: secrets and .git internals are omitted, never merely flagged", () => {
  const names = reader.list("", 2).entries.map((e) => e.path);
  for (const hidden of [".env", ".env.staging", ".ssh", "config/server.pem", "config/id_rsa", ".git"]) assert.ok(!names.includes(hidden), `${hidden} must not be listed`);
  assert.ok(names.includes("config/settings.json"));
});

test("list: symlink entries are skipped without failing the listing", () => {
  const names = reader.list("").entries.map((e) => e.path);
  for (const link of ["escape-dir", "escape-file.txt", "env-link.txt", "app-link.ts"]) assert.ok(!names.includes(link), `${link} must be skipped`);
  assert.ok(names.includes("README.md"), "the rest of the listing continues");
});

test("list: respects the entry limit and reports truncation", () => {
  const small = new FilesystemReader({ root, limits: { ...LIMITS, maxDirEntries: 3 } });
  const out = small.list("");
  assert.equal(out.entries.length, 3);
  assert.equal(out.truncated, true);
});

test("find: glob, substring, scoped path, no-result, limits and skipped symlinks", () => {
  assert.deepEqual(reader.find("*.test.ts").matches.map((m) => m.path), ["src/lib/server.test.ts"]);
  assert.deepEqual(reader.find("server").matches.map((m) => m.path), ["src/lib/server.test.ts"], "denied config/server.pem must not match");
  assert.deepEqual(reader.find("guide").matches.map((m) => m.path), ["docs/Guide.md"], "case-insensitive");
  assert.deepEqual(reader.find("util", "src").matches.map((m) => m.path), ["src/lib/util.ts"]);
  assert.deepEqual(reader.find("src/**/app.ts").matches.map((m) => m.path), ["src/app.ts"]);
  assert.deepEqual(reader.find("app-link").matches, [], "symlink entries are not discoverable");
  assert.deepEqual(reader.find("definitely-not-here").matches, []);
  assert.ok(!reader.find("index.js").matches.length, "node_modules is skipped");
  assert.equal(reader.find("*", "", 2).matches.length, 2);
  assert.equal(reader.find("*").truncated, true, "maxSearchResults caps an unbounded glob");
  assert.equal(code(() => reader.find("  ")), "INVALID_ARGUMENT");
  const tiny = new FilesystemReader({ root, limits: { ...LIMITS, maxScanEntries: 2 } });
  assert.equal(tiny.find("*").truncated, true, "the scan budget stops the walk");
});

test("read: whole file, range, paging and past-the-end", () => {
  const all = reader.read("src/app.ts");
  assert.equal(all.totalLines, 4);
  assert.equal(all.nextStartLine, null);
  assert.ok(all.content.startsWith("1: export const answer = 42;"));
  const range = reader.read("lines.txt", 3, 5);
  assert.equal(range.content, "3: line 3\n4: line 4\n5: line 5");
  assert.equal(range.nextStartLine, 6);
  const capped = reader.read("lines.txt", 1, 30);
  assert.equal(capped.endLine, 10, "maxReadLines=10");
  assert.equal(capped.truncated, true);
  assert.equal(capped.nextStartLine, 11);
  assert.equal(reader.read("lines.txt", capped.nextStartLine as number).startLine, 11);
  assert.equal(code(() => reader.read("lines.txt", 99)), "INVALID_ARGUMENT");
  assert.equal(code(() => reader.read("lines.txt", 5, 2)), "INVALID_ARGUMENT");
});

test("read: not found, directory, oversized and binary are refused with clear codes", () => {
  assert.equal(code(() => reader.read("nope.ts")), "NOT_FOUND");
  assert.equal(code(() => reader.read("src")), "NOT_FILE");
  assert.equal(code(() => reader.read("big.txt")), "TOO_LARGE");
  assert.equal(code(() => reader.read("blob.bin")), "BINARY");
  assert.equal(code(() => reader.list("README.md")), "NOT_DIRECTORY");
  assert.equal(code(() => reader.read("")), "NOT_FILE");
});

test("read: output is bounded in characters as well as lines", () => {
  const dir = makeFixture().root;
  writeFileSync(path.join(dir, "wide.txt"), Array.from({ length: 10 }, () => "z".repeat(900)).join("\n"));
  const wide = new FilesystemReader({ root: dir, limits: { maxFileBytes: 20_000, maxReadLines: 500, maxReadChars: 2000 } });
  const out = wide.read("wide.txt");
  assert.ok(out.content.length <= 2000);
  assert.equal(out.truncated, true);
  assert.equal(out.totalLines, 10);
});

test("read: redaction in place, whole-file refusal for key material, templates readable", () => {
  const { root: dir } = makeFixture();
  const key = "-----BEGIN " + "OPENSSH PRIVATE KEY" + "-----\nb3BlbnNzaA==\n-----END " + "OPENSSH PRIVATE KEY" + "-----\n";
  const secretLine = "DB_PASS" + "WORD=s3cr3t-value-here";
  writeFileSync(path.join(dir, "notes.txt"), key);
  writeFileSync(path.join(dir, "settings.txt"), `line one\n${secretLine}\nline three\n`);
  writeFileSync(path.join(dir, ".env.example"), "PORT=3000\n");
  const r = new FilesystemReader({ root: dir, limits: { maxFileBytes: 5000 } });
  assert.equal(code(() => r.read("notes.txt")), "DENIED", "key material under an innocent name is refused whole");
  const settings = r.read("settings.txt");
  assert.equal(settings.redactions, 1);
  assert.ok(!settings.content.includes("s3cr3t-value-here"));
  assert.ok(settings.content.includes(REDACTED) && settings.content.includes("1: line one") && settings.content.includes("3: line three"));
  assert.match(r.read(".env.example").content, /PORT=3000/);
  assert.equal(code(() => r.read(".env")), "DENIED");
  assert.equal(code(() => r.read(".env.production")), "DENIED", "a missing denied path answers the same");
  assert.equal(code(() => r.read("prod.env")), "DENIED");
  assert.equal(code(() => r.read(".ENV")), "DENIED", "case variants");
});

test("confinement: traversal, absolute paths and backslash forms are refused", () => {
  for (const p of ["../outside/notes.txt", "src/../../outside/notes.txt", "/etc/passwd", "..", "..\\outside\\notes.txt", "C:\\Windows\\win.ini"]) {
    assert.equal(code(() => reader.read(p)), "OUTSIDE_ROOT", p);
  }
  assert.equal(code(() => reader.list("..")), "OUTSIDE_ROOT");
  assert.equal(code(() => reader.read("a\0b")), "INVALID_ARGUMENT");
});

test("symlinks: direct operations are refused, even to an allowed in-root file", () => {
  for (const p of ["escape-file.txt", "escape-dir", "escape-dir/notes.txt", "app-link.ts"]) assert.equal(code(() => reader.read(p)), "SYMLINK_REFUSED", p);
  assert.equal(code(() => reader.list("escape-dir")), "SYMLINK_REFUSED");
  assert.equal(code(() => reader.find("x", "escape-dir")), "SYMLINK_REFUSED");
  assert.equal(code(() => reader.search({ patterns: ["x"], path: "escape-dir" })), "SYMLINK_REFUSED");
  assert.equal(code(() => reader.readImage("escape-file.txt")), "SYMLINK_REFUSED");
});

test("symlinks: a link in the middle of a path is refused, and a link to a denied file stays refused", () => {
  const { root: dir } = makeFixture();
  symlinkSync(path.join(dir, "src"), path.join(dir, "src-link"));
  const r = new FilesystemReader({ root: dir, limits: LIMITS });
  assert.equal(code(() => r.read("src-link/app.ts")), "SYMLINK_REFUSED");
  assert.equal(code(() => r.read("env-link.txt")), "SYMLINK_REFUSED");
  assert.equal(code(() => r.read(".env")), "DENIED", "the lexical deny rule answers first for the real name");
});

test("policy: denied paths answer DENIED whether or not they exist", () => {
  for (const p of [".env", ".env.staging", "config/server.pem", "config/id_rsa", ".git/config", ".env.production"]) assert.equal(code(() => reader.read(p)), "DENIED", p);
  assert.equal(code(() => reader.list(".ssh")), "DENIED");
});

test("policy: extra deny globs are additive", () => {
  const extra = new FilesystemReader({ root, limits: LIMITS, extraDenyGlobs: ["docs/**"] });
  assert.equal(code(() => extra.read("docs/Guide.md")), "DENIED");
  assert.equal(code(() => extra.read(".env")), "DENIED", "built-ins stay");
  assert.ok(!extra.find("guide").matches.length);
});

test("every operation shares one policy: denied and escaping paths fail the same way everywhere", () => {
  const probes: [string, string][] = [
    [".env", "DENIED"],
    ["config/server.pem", "DENIED"],
    [".git/config", "DENIED"],
    ["../outside", "OUTSIDE_ROOT"],
    ["escape-dir", "SYMLINK_REFUSED"],
    ["env-link.txt", "SYMLINK_REFUSED"],
    ["/etc/passwd", "OUTSIDE_ROOT"],
    ["%2e%2e/outside", "NOT_FOUND"],
  ];
  for (const [p, expected] of probes) {
    assert.equal(code(() => reader.read(p)), expected, `read ${p}`);
    assert.equal(code(() => reader.list(p)), expected, `list ${p}`);
    assert.equal(code(() => reader.find("x", p)), expected, `find ${p}`);
    assert.equal(code(() => reader.search({ patterns: ["x"], path: p })), expected, `search ${p}`);
    assert.equal(code(() => reader.readImage(p)), expected, `image ${p}`);
  }
});

test("the reader rejects a root that is not a directory and invalid limits", () => {
  assert.throws(() => new FilesystemReader({ root: path.join(root, "README.md") }));
  assert.throws(() => new FilesystemReader({ root, limits: { maxFileBytes: 0 } }));
});
