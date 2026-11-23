// Pure path rules, including the Windows classes, run on any host by passing the platform explicitly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPathPolicy, isInsideRoot, normalizeRelativePath } from "../src/filesystem/index.ts";
import { code } from "./fixture.ts";

const posix = (p: string) => normalizeRelativePath(p, "posix");
const win = (p: string) => normalizeRelativePath(p, "win32");

test("normalise: relative paths pass, traversal and absolute forms do not", () => {
  assert.equal(posix(""), "");
  assert.equal(posix("."), "");
  assert.equal(posix("src//lib/./util.ts"), "src/lib/util.ts");
  assert.equal(posix("src/"), "src");
  assert.equal(code(() => posix("../x")), "OUTSIDE_ROOT");
  assert.equal(code(() => posix("src/../../x")), "OUTSIDE_ROOT");
  assert.equal(code(() => posix("..")), "OUTSIDE_ROOT");
  assert.equal(code(() => posix("/etc/passwd")), "OUTSIDE_ROOT");
  assert.equal(code(() => posix("a\0b")), "INVALID_ARGUMENT");
  assert.equal(posix("..hidden/file"), "..hidden/file", "a name that merely starts with two dots is not traversal");
});

test("normalise: backslashes are separators on every platform", () => {
  assert.equal(posix("src\\lib\\util.ts"), "src/lib/util.ts");
  assert.equal(code(() => posix("..\\x")), "OUTSIDE_ROOT");
  assert.equal(code(() => posix("\\etc\\passwd")), "OUTSIDE_ROOT");
});

test("windows: drive letters, UNC and extended-length forms are outside the root", () => {
  for (const p of ["C:\\Windows\\system.ini", "c:/Windows", "C:foo", "D:", "\\\\server\\share\\x", "//server/share/x", "\\\\?\\C:\\x", "\\\\.\\pipe\\x"]) {
    assert.equal(code(() => win(p)), "OUTSIDE_ROOT", p);
  }
  assert.equal(code(() => posix("C:\\Windows")), "OUTSIDE_ROOT", "drive-letter paths are refused on posix too");
});

test("windows: NTFS alternate data streams are refused", () => {
  for (const p of ["file.txt:stream", "file.txt::$DATA", "dir/file.txt:hidden:$DATA", ".env:stream"]) {
    assert.equal(code(() => win(p)), "INVALID_ARGUMENT", p);
  }
  assert.equal(posix("a:b.txt"), "a:b.txt", "a colon is an ordinary character on posix");
});

test("windows: reserved device names are refused, with or without an extension", () => {
  for (const p of ["CON", "con", "NUL.txt", "dir/AUX", "dir/aux.tar.gz", "COM1", "lpt9.log", "PRN."]) {
    assert.equal(code(() => win(p)), "INVALID_ARGUMENT", p);
  }
  for (const p of ["console.ts", "com10", "nullable.txt", "dir/auxiliary"]) assert.equal(code(() => win(p)), "NO_ERROR", p);
  assert.equal(posix("con"), "con", "ordinary file name on posix");
});

test("windows: trailing dots and spaces collapse so they cannot dodge the deny rules", () => {
  assert.equal(win(".env."), ".env");
  assert.equal(win("config/server.pem  "), "config/server.pem");
  assert.equal(win("a. ./b"), "a/b");
  const policy = buildPathPolicy();
  assert.equal(policy.isDenied(win(".env.")), true);
  assert.equal(policy.isDenied(win("config/Server.PEM . ")), true);
  assert.equal(code(() => win("...")), "INVALID_ARGUMENT");
});

test("deny: built-in secret paths, case variants and templates", () => {
  const policy = buildPathPolicy();
  for (const p of [".env", ".ENV", ".env.staging", "prod.env", "config/server.pem", "CONFIG/SERVER.PEM", "a/id_rsa", "a/id_ed25519.pub", ".git/config", "x/.git/hooks/pre-commit", ".ssh", ".ssh/known_hosts", "a/credentials.json", "data.sqlite"]) {
    assert.equal(policy.isDenied(p), true, p);
  }
  for (const p of [".env.example", ".env.sample", "src/app.ts", "docs/readme.md", "config/settings.json"]) assert.equal(policy.isDenied(p), false, p);
});

test("deny: extra globs only add to the floor", () => {
  const policy = buildPathPolicy(["docs/**"]);
  assert.equal(policy.isDenied("docs/Guide.md"), true);
  assert.equal(policy.isDenied(".env"), true);
  assert.equal(buildPathPolicy([]).isDenied("docs/Guide.md"), false);
});

test("containment: a sibling with the same prefix is not inside the root", () => {
  assert.equal(isInsideRoot("/root", "/root", "posix"), true);
  assert.equal(isInsideRoot("/root", "/root/a/b", "posix"), true);
  assert.equal(isInsideRoot("/root", "/root2/a", "posix"), false);
  assert.equal(isInsideRoot("/root", "/other", "posix"), false);
  assert.equal(isInsideRoot("/root", "/", "posix"), false);
});

test("containment on windows is case-insensitive and drive aware", () => {
  assert.equal(isInsideRoot("C:\\Repo", "c:\\repo\\SRC\\a.ts", "win32"), true);
  assert.equal(isInsideRoot("C:\\Repo", "C:\\Repo2\\a.ts", "win32"), false);
  assert.equal(isInsideRoot("C:\\Repo", "D:\\Repo\\a.ts", "win32"), false);
  assert.equal(isInsideRoot("C:\\Repo", "\\\\server\\share\\Repo", "win32"), false);
});

test("precedence: immutable safety deny > explicit deny > explicit allow > inherited sensitive deny > inherited allow", () => {
  const none = buildPathPolicy();
  assert.equal(none.isDenied(".env"), true, "inherited sensitive default");
  assert.equal(none.isDenied("src/app.ts"), false, "inherited allow is the default");
  const allowEnv = buildPathPolicy([], [".env", "config/**"]);
  assert.equal(allowEnv.isDenied(".env"), false, "an explicit allow beats the inherited deny");
  assert.equal(allowEnv.isDenied("config/server.pem"), false, "...for keys and other sensitive defaults too");
  assert.equal(allowEnv.isDenied("other/.env"), true, "...but only the exact paths it names");
  assert.equal(allowEnv.isDenied(".env.production"), true, "a neighbouring sensitive default stays denied");
  const both = buildPathPolicy(["config/private/**"], ["config/**"]);
  assert.equal(both.isDenied("config/private/a.txt"), true, "an explicit deny beats an explicit allow");
  assert.equal(both.isDenied("config/public/a.txt"), false);
  const everything = buildPathPolicy([], ["**"]);
  for (const immutable of [".git", ".git/config", "x/.git/hooks/pre-commit"]) assert.equal(everything.isDenied(immutable), true, `${immutable} is never opened by an Access Rule`);
  assert.equal(everything.isDenied(".env"), false);
  const dirAllow = buildPathPolicy([], ["secrets/**"]);
  assert.equal(dirAllow.isDenied("secrets"), false, "the directory entry follows its allowed contents");
  assert.equal(dirAllow.isDenied("secrets/token.json"), false);
  assert.equal(buildPathPolicy([], [".env"]).denyGlobs.includes("**/.env"), true, "the listed deny globs stay conservative");
});
