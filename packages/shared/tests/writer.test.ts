// Controlled writes: atomic store, exact edit, delete-as-trash, purge and the protected-overwrite guard.
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FilesystemWriter, REDACTED, TRASH_DIR, type FsLimits } from "../src/filesystem/index.ts";
import { code } from "./fixture.ts";

// Secret-shaped samples are assembled from parts so this file never holds a literal one.
const SECRET_LINE = "DB_PASS" + "WORD=s3cr3t-value-here\n";
const KEY = "-----BEGIN " + "RSA PRIVATE KEY" + "-----\nabc\n-----END " + "RSA PRIVATE KEY" + "-----\n";

function setup(limits: Partial<FsLimits> = {}, now: () => number = Date.now) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "reach-fs-write-")));
  const area = path.join(base, "project", "scratch");
  const outside = path.join(base, "outside");
  mkdirSync(area, { recursive: true });
  mkdirSync(outside);
  writeFileSync(path.join(outside, "notes.txt"), "outside data\n");
  const writer = new FilesystemWriter({ root: area, projectRoot: path.join(base, "project"), limits: { maxWriteFileBytes: 1000, ...limits }, now });
  return { area, outside, writer };
}
const read = (...p: string[]) => readFileSync(path.join(...p), "utf8");

test("write: creates files, overwrites ordinary text, leaves no temp residue", () => {
  const { area, writer } = setup();
  assert.deepEqual(writer.write("notes/a.md", "hello\n"), { path: "notes/a.md", bytes: 6 });
  writer.write("notes/a.md", "hello world\n");
  assert.equal(read(area, "notes/a.md"), "hello world\n");
  assert.deepEqual(writer.write("bin.dat", Buffer.from([1, 2, 3]).toString("base64"), "base64"), { path: "bin.dat", bytes: 3 });
  assert.deepEqual(readdirSync(path.join(area, "notes")).filter((n) => n.endsWith(".tmp")), []);
});

test("write: the per-file limit is configurable and a refused overwrite keeps the old bytes", () => {
  const { area, writer } = setup({ maxWriteFileBytes: 10 });
  assert.equal(code(() => writer.write("big.txt", "x".repeat(11))), "TOO_LARGE");
  assert.equal(existsSync(path.join(area, "big.txt")), false);
  writer.write("ok.txt", "x".repeat(10));
  assert.equal(code(() => writer.write("ok.txt", "y".repeat(11))), "TOO_LARGE");
  assert.equal(read(area, "ok.txt"), "x".repeat(10));
  assert.equal(code(() => writer.write("b64", Buffer.alloc(11).toString("base64"), "base64")), "TOO_LARGE");
});

test("paths: traversal, absolute, drive, NUL and any .. segment are refused; nothing lands outside", () => {
  const { area, writer } = setup();
  for (const p of ["../x.txt", "a/../../x.txt", "..", "..\\x.txt", "/etc/x.txt", `${area}/x.txt`, "C:/x.txt", "a\0b", "a/../b.txt", "./../x"]) {
    assert.match(code(() => writer.write(p, "x")), /OUTSIDE_ROOT|INVALID_ARGUMENT/, p);
  }
  assert.equal(code(() => writer.write("", "x")), "INVALID_ARGUMENT");
  assert.equal(code(() => writer.write(".", "x")), "INVALID_ARGUMENT");
  assert.equal(existsSync(path.join(path.dirname(area), "x.txt")), false);
});

test("symlinks: any link on the way, to a file or a directory, in or out, is refused", () => {
  const { area, outside, writer } = setup();
  mkdirSync(path.join(area, "real"));
  writeFileSync(path.join(area, "real/f.txt"), "keep");
  symlinkSync(outside, path.join(area, "out-dir"));
  symlinkSync(path.join(outside, "notes.txt"), path.join(area, "out-file"));
  symlinkSync(path.join(area, "real/f.txt"), path.join(area, "in-file"));
  symlinkSync(path.join(area, "real"), path.join(area, "in-dir"));
  for (const p of ["out-dir/pwn.txt", "out-dir/deep/pwn.txt", "out-file", "in-file", "in-dir/ok.txt"]) assert.equal(code(() => writer.write(p, "x")), "SYMLINK_REFUSED", p);
  assert.equal(code(() => writer.edit("out-file", "outside", "x")), "SYMLINK_REFUSED");
  assert.equal(code(() => writer.remove("in-file")), "SYMLINK_REFUSED");
  assert.equal(read(area, "real/f.txt"), "keep");
  assert.equal(read(outside, "notes.txt"), "outside data\n");
  assert.equal(existsSync(path.join(outside, "pwn.txt")), false);
});

test("deny policy and the trash apply to writes; allow globs narrow the surface", () => {
  const { writer } = setup();
  for (const p of ["x.sqlite", "credentials.json", "id_rsa", "k.pem", ".env", ".env.staging", ".git/config", ".ssh/authorized_keys", ".lixeira/x.txt", ".LIXEIRA/x.txt".toLowerCase()]) {
    assert.equal(code(() => writer.write(p, "x")), "DENIED", p);
  }
  assert.equal(code(() => writer.remove(TRASH_DIR)), "DENIED");
  writer.write(".env.example", "NAME=\n");
  const { area } = setup();
  const narrow = new FilesystemWriter({ root: area, allowGlobs: ["docs/**", ".gitlab-ci.yml"], limits: { maxWriteFileBytes: 1000 } });
  narrow.write("docs/a.md", "a");
  narrow.write(".gitlab-ci.yml", "a: 1\n");
  assert.equal(code(() => narrow.write("src/a.ts", "x")), "DENIED");
});

test("overwrite guard: a file whose read is redacted cannot be replaced; the original bytes survive", () => {
  const { area, writer } = setup();
  writeFileSync(path.join(area, "settings.txt"), `line one\n${SECRET_LINE}`);
  const original = readFileSync(path.join(area, "settings.txt"));
  // The round trip the guard exists for: read-style redacted text written back over the original.
  const redactedView = `line one\nDB_PASS` + `WORD=${REDACTED}\n`;
  assert.equal(code(() => writer.write("settings.txt", redactedView)), "DENIED");
  assert.deepEqual(readFileSync(path.join(area, "settings.txt")), original);
  assert.deepEqual(readdirSync(area).filter((n) => n.endsWith(".tmp")), [], "the refused store leaves no temp file");
});

test("overwrite guard: key material and binary targets are refused, new files and plain text are not", () => {
  const { area, writer } = setup();
  writeFileSync(path.join(area, "notes.txt"), KEY);
  writeFileSync(path.join(area, "blob.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  writeFileSync(path.join(area, "plain.txt"), "nothing secret\n");
  assert.equal(code(() => writer.write("notes.txt", "replacement")), "DENIED");
  assert.equal(code(() => writer.write("blob.bin", "replacement")), "DENIED");
  assert.equal(read(area, "notes.txt"), KEY);
  assert.deepEqual(readFileSync(path.join(area, "blob.bin")), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  writer.write("plain.txt", "changed\n");
  writer.write("fresh.txt", "new\n");
  assert.equal(read(area, "plain.txt"), "changed\n");
});

test("targeted edit still works on a protected file and never returns its content", () => {
  const { area, writer } = setup();
  writeFileSync(path.join(area, "settings.txt"), `line one\n${SECRET_LINE}line three\n`);
  const out = writer.edit("settings.txt", "line one", "line 1");
  assert.deepEqual(Object.keys(out).sort(), ["bytes", "path", "replacements"]);
  assert.ok(!JSON.stringify(out).includes("s3cr3t"));
  assert.equal(read(area, "settings.txt"), `line 1\n${SECRET_LINE}line three\n`, "the protected value is untouched");
  assert.equal(code(() => writer.edit("settings.txt", "zzz", "y")), "NOT_FOUND");
  assert.equal(code(() => writer.edit("settings.txt", "", "y")), "INVALID_ARGUMENT");
  assert.equal(code(() => writer.edit("missing.txt", "a", "b")), "NOT_FOUND");
  try {
    writer.edit("settings.txt", "zzz", "y");
  } catch (err) {
    assert.ok(!(err as Error).message.includes("s3cr3t"), "errors do not echo file content");
  }
});

test("edit: ambiguity needs replaceAll, binary files are refused", () => {
  const { area, writer } = setup();
  writer.write("dup.txt", "x x");
  assert.equal(code(() => writer.edit("dup.txt", "x", "y")), "NOT_UNIQUE");
  assert.equal(read(area, "dup.txt"), "x x");
  assert.equal(writer.edit("dup.txt", "x", "y", true).replacements, 2);
  writeFileSync(path.join(area, "blob.bin"), Buffer.from([1, 0, 2]));
  assert.equal(code(() => writer.edit("blob.bin", "a", "b")), "BINARY");
});

test("atomic store: a failure before the rename leaves the previous target intact and no temp file", { skip: process.getuid?.() === 0 }, () => {
  const { area, writer } = setup();
  writer.write("keep.txt", "before\n");
  chmodSync(area, 0o555);
  try {
    assert.throws(() => writer.write("keep.txt", "after\n"));
  } finally {
    chmodSync(area, 0o755);
  }
  assert.equal(read(area, "keep.txt"), "before\n");
  assert.deepEqual(readdirSync(area).filter((n) => n.endsWith(".tmp")), []);
});

test("remove: moves into dated trash, never unlinks, collisions get -2/-3 suffixes", () => {
  const clock = new Date(2026, 9, 1, 12, 0, 0).getTime();
  const { area, writer } = setup({}, () => clock);
  writer.write("n.md", "one");
  assert.equal(writer.remove("n.md").movedTo, `${TRASH_DIR}/2026-10-01/n.md`);
  assert.equal(existsSync(path.join(area, "n.md")), false);
  writer.write("n.md", "two");
  assert.equal(writer.remove("n.md").movedTo, `${TRASH_DIR}/2026-10-01/n-2.md`);
  writer.write("n.md", "three");
  assert.equal(writer.remove("n.md").movedTo, `${TRASH_DIR}/2026-10-01/n-3.md`);
  const day = path.join(area, TRASH_DIR, "2026-10-01");
  assert.deepEqual([read(day, "n.md"), read(day, "n-2.md"), read(day, "n-3.md")], ["one", "two", "three"]);
  writer.write("tree/a/b.txt", "deep");
  const dir = writer.remove("tree");
  assert.equal(read(area, dir.movedTo, "a/b.txt"), "deep");
  writer.write("d/x.txt", "x");
  writer.remove("d");
  writer.write("d/x.txt", "y");
  assert.equal(writer.remove("d").movedTo, `${TRASH_DIR}/2026-10-01/d-2`);
  assert.equal(code(() => writer.remove("nope.txt")), "NOT_FOUND");
  assert.equal(code(() => writer.remove(`${TRASH_DIR}/2026-10-01/n.md`)), "DENIED", "the trash cannot be deleted or written directly");
  assert.equal(code(() => writer.remove(".")), "INVALID_ARGUMENT");
});

// --- Cross-filesystem remove (EXDEV): the trash is a different mount than the entry being removed. ---
// A real second mount needs privileges, so fs.renameSync is replaced (and the ESM named export re-synced) to fail for moves into the trash.
const CLOCK = new Date(2026, 9, 1, 12, 0, 0).getTime();
function failTrashRename<T>(errno: string, body: () => T): T {
  const original = fs.renameSync;
  const stub = mock.method(fs, "renameSync", (from: string, to: string) => {
    if (to.split(path.sep).includes(TRASH_DIR)) throw Object.assign(new Error(`${errno}: simulated`), { code: errno });
    return original(from, to);
  });
  syncBuiltinESMExports();
  try {
    return body();
  } finally {
    stub.mock.restore();
    syncBuiltinESMExports();
  }
}
const exdev = <T>(body: () => T): T => failTrashRename("EXDEV", body);

test("remove across filesystems: a file is copied byte for byte (larger than one chunk), the source disappears, mode is kept", () => {
  const { area, writer } = setup({}, () => CLOCK);
  const bytes = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 7) % 256));
  writeFileSync(path.join(area, "big.bin"), bytes);
  chmodSync(path.join(area, "big.bin"), 0o640);
  const result = exdev(() => writer.remove("big.bin"));
  assert.equal(result.movedTo, `${TRASH_DIR}/2026-10-01/big.bin`);
  const moved = path.join(area, result.movedTo);
  assert.ok(readFileSync(moved).equals(bytes));
  assert.equal(statSync(moved).mode & 0o777, 0o640);
  assert.equal(existsSync(path.join(area, "big.bin")), false);
  writer.write("big.bin", "again");
  assert.equal(exdev(() => writer.remove("big.bin")).movedTo, `${TRASH_DIR}/2026-10-01/big-2.bin`, "collision suffixes still apply");
});

test("remove across filesystems: a directory tree keeps hidden entries, empty directories and symlinks (never followed)", () => {
  const { area, outside, writer } = setup({}, () => CLOCK);
  const tree = path.join(area, "tree");
  mkdirSync(path.join(tree, ".hidden-dir"), { recursive: true });
  mkdirSync(path.join(tree, "empty"));
  mkdirSync(path.join(tree, "sub"));
  writeFileSync(path.join(tree, ".hidden-file"), "h");
  writeFileSync(path.join(tree, ".hidden-dir", ".inner"), "i");
  writeFileSync(path.join(tree, "sub", "a.txt"), "a");
  symlinkSync(path.join(outside, "notes.txt"), path.join(tree, "link"));
  chmodSync(path.join(tree, "sub"), 0o555);
  try {
    const result = exdev(() => writer.remove("tree"));
    const moved = path.join(area, result.movedTo);
    assert.equal(read(moved, ".hidden-file"), "h");
    assert.equal(read(moved, ".hidden-dir", ".inner"), "i");
    assert.equal(read(moved, "sub", "a.txt"), "a");
    assert.ok(statSync(path.join(moved, "empty")).isDirectory());
    assert.equal(statSync(path.join(moved, "sub")).mode & 0o777, 0o555);
    assert.ok(lstatSync(path.join(moved, "link")).isSymbolicLink());
    assert.equal(readlinkSync(path.join(moved, "link")), path.join(outside, "notes.txt"));
    assert.equal(read(outside, "notes.txt"), "outside data\n", "the symlink target is untouched");
    assert.equal(existsSync(tree), false);
  } finally {
    chmodSync(path.join(area, TRASH_DIR, "2026-10-01", "tree", "sub"), 0o755);
  }
});

test("remove: a non-EXDEV rename error propagates, with no copy fallback and the source intact", () => {
  const { area, writer } = setup({}, () => CLOCK);
  writer.write("keep.txt", "keep");
  assert.throws(() => failTrashRename("EACCES", () => writer.remove("keep.txt")), { code: "EACCES" });
  assert.equal(read(area, "keep.txt"), "keep");
  assert.deepEqual(readdirSync(path.join(area, TRASH_DIR, "2026-10-01")), []);
});

test("remove across filesystems: a copy that fails midway leaves the original intact, cleans the partial copy and reports the error", () => {
  const { area, writer } = setup({}, () => CLOCK);
  writer.write("tree/a.txt", "a");
  writer.write("tree/b.txt", "b");
  const original = fs.readSync;
  let calls = 0;
  const stub = mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
    if (++calls === 2) throw Object.assign(new Error("EIO: simulated"), { code: "EIO" });
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => exdev(() => writer.remove("tree")), { code: "EIO" });
  } finally {
    stub.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(read(area, "tree/a.txt"), "a");
  assert.equal(read(area, "tree/b.txt"), "b");
  assert.deepEqual(readdirSync(path.join(area, TRASH_DIR, "2026-10-01")), [], "no partial copy is left in the trash");
});

test("remove across filesystems: an entry that is not a file, directory or symlink is refused before anything is removed", () => {
  const { area, writer } = setup({}, () => CLOCK);
  const socketDir = path.join(area, "dev");
  mkdirSync(socketDir);
  writeFileSync(path.join(socketDir, "ok.txt"), "ok");
  const original = fs.lstatSync;
  const stub = mock.method(fs, "lstatSync", (p: string, ...rest: unknown[]) => {
    const st = (original as (...a: unknown[]) => fs.Stats)(p, ...rest);
    return p.endsWith("ok.txt") ? Object.assign(Object.create(st), { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false }) : st;
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => exdev(() => writer.remove("dev")), { code: "NOT_FILE" });
  } finally {
    stub.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(read(socketDir, "ok.txt"), "ok");
  assert.deepEqual(readdirSync(path.join(area, TRASH_DIR, "2026-10-01")), []);
});

test("trash belongs to the physical writable root: two roots each trash only into their own .lixeira", () => {
  const a = setup({}, () => CLOCK);
  const b = setup({}, () => CLOCK);
  a.writer.write("same.txt", "from A");
  b.writer.write("same.txt", "from B");
  assert.equal(a.writer.remove("same.txt").movedTo, `${TRASH_DIR}/2026-10-01/same.txt`);
  assert.equal(exdev(() => b.writer.remove("same.txt")).movedTo, `${TRASH_DIR}/2026-10-01/same.txt`);
  assert.equal(read(a.area, TRASH_DIR, "2026-10-01", "same.txt"), "from A");
  assert.equal(read(b.area, TRASH_DIR, "2026-10-01", "same.txt"), "from B");
  assert.deepEqual(readdirSync(a.area).sort(), [TRASH_DIR]);
  assert.deepEqual(readdirSync(b.area).sort(), [TRASH_DIR]);
});

test("purge: counts calendar days from the folder name, keeps malformed and non-directory entries", () => {
  let clock = new Date(2026, 9, 1, 23, 30, 0).getTime();
  const { area, writer } = setup({ trashRetentionDays: 15 }, () => clock);
  writer.write("a.txt", "a");
  writer.remove("a.txt");
  clock = new Date(2026, 9, 11, 0, 10, 0).getTime();
  writer.write("b.txt", "b");
  writer.remove("b.txt");
  const trash = path.join(area, TRASH_DIR);
  mkdirSync(path.join(trash, "keep-me-not-a-date"));
  writeFileSync(path.join(trash, "stray-file.txt"), "x");
  for (const name of ["2020-13-40", "2020-02-31", "2020-1-1", "2020-01-01-old"]) mkdirSync(path.join(trash, name));
  clock = new Date(2026, 9, 16, 23, 59, 0).getTime();
  assert.deepEqual(writer.purgeTrash(), [], "exactly 15 days old is kept, whatever the hour");
  clock = new Date(2026, 9, 17, 0, 1, 0).getTime();
  assert.deepEqual(writer.purgeTrash(), ["2026-10-01"], "16 days old goes, newer stays");
  assert.ok(existsSync(path.join(trash, "2026-10-11")));
  for (const name of ["keep-me-not-a-date", "stray-file.txt", "2020-13-40", "2020-02-31", "2020-1-1", "2020-01-01-old"]) assert.ok(existsSync(path.join(trash, name)), name);
  clock = new Date(2026, 10, 30, 12, 0, 0).getTime();
  writer.write("c.txt", "c");
  assert.equal(existsSync(path.join(trash, "2026-10-11")), false, "any write purges expired trash");
  assert.ok(existsSync(path.join(area, "c.txt")), "live files are never purged");
});

test("purge: a symlink named like an old date is not followed or removed; retention is configurable", () => {
  const clock = new Date(2030, 0, 1, 12).getTime();
  const { area, outside, writer } = setup({ trashRetentionDays: 2 }, () => clock);
  const trash = path.join(area, TRASH_DIR);
  mkdirSync(trash);
  symlinkSync(outside, path.join(trash, "2020-01-01"));
  mkdirSync(path.join(trash, "2029-12-29"));
  mkdirSync(path.join(trash, "2029-12-31"));
  assert.deepEqual(writer.purgeTrash(), ["2029-12-29"]);
  assert.equal(read(outside, "notes.txt"), "outside data\n");
});

test("windows policy is inherited: ADS, device names and drive forms are refused", () => {
  const { area } = setup();
  const w = new FilesystemWriter({ root: area, platform: "win32", limits: { maxWriteFileBytes: 1000 } });
  assert.equal(code(() => w.write("file.txt:stream", "x")), "INVALID_ARGUMENT");
  assert.equal(code(() => w.write("dir/NUL.txt", "x")), "INVALID_ARGUMENT");
  assert.equal(code(() => w.write("C:\\x.txt", "x")), "OUTSIDE_ROOT");
  assert.equal(code(() => w.write(".LIXEIRA/x.txt", "x")), "DENIED", "the trash name is case-insensitive on windows");
  assert.equal(code(() => w.write(".env.", "x")), "DENIED");
});

test("the writer rejects a project root that does not contain the write root", () => {
  const { area, outside } = setup();
  assert.throws(() => new FilesystemWriter({ root: area, projectRoot: outside }));
});

test("overwrite guard follows the READ limit, not the write limit, for the existing file", () => {
  const { area, writer } = setup({ maxFileBytes: 100, maxWriteFileBytes: 1000 });
  const big = "x".repeat(500);
  writeFileSync(path.join(area, "big.txt"), big);
  assert.equal(code(() => writer.write("big.txt", "replacement")), "DENIED", "a normal read would refuse this file, so the overwrite is refused");
  assert.equal(read(area, "big.txt"), big, "original bytes intact");
  assert.deepEqual(readdirSync(area).filter((n) => n.endsWith(".tmp")), []);
  assert.equal(writer.write("new-big.txt", "y".repeat(500)).bytes, 500, "a new file of that size is still allowed by the write limit");
  writeFileSync(path.join(area, "small.txt"), "z".repeat(100));
  writer.write("small.txt", "changed");
  assert.equal(read(area, "small.txt"), "changed", "an existing file within the read limit still overwrites");
  assert.equal(writer.edit("big.txt", "xxx", "yyy", true).replacements, 166, "targeted edit keeps using the write bound");
});
