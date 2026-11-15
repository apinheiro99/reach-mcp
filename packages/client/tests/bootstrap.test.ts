import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acceptEffectivePolicy, BootstrapError, loadBootstrap, parseBootstrap } from "../src/index.ts";
import { EffectiveProjectPolicy } from "../../shared/src/wire/index.ts";
import { FsError } from "../../shared/src/filesystem/index.ts";

const CRED = "cred-marker-" + "Zq72nVx";
const base = mkdtempSync(path.join(tmpdir(), "reach-client-"));
const anchor = path.join(base, "safe", "root");
const evil = path.join(base, "safe", "root-evil");
const outside = path.join(base, "outside");
for (const d of [path.join(anchor, "proj"), evil, outside]) mkdirSync(d, { recursive: true });
symlinkSync(outside, path.join(anchor, "escape"));
symlinkSync(path.join(anchor, "proj"), path.join(anchor, "inside-link"));
const aliasOfAnchor = path.join(base, "alias");
symlinkSync(anchor, aliasOfAnchor);

const file = (over: Record<string, string | undefined> = {}) =>
  Object.entries({ REACH_SERVER_URL: "wss://server.example/ws", REACH_CLIENT_ID: "laptop-1", REACH_CLIENT_CREDENTIAL: CRED, REACH_ROOTS: JSON.stringify([anchor]), ...over })
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
const problems = (text: string, opts = {}) => {
  try {
    parseBootstrap(text, opts);
  } catch (err) {
    assert.ok(err instanceof BootstrapError);
    assert.ok(!err.message.includes(CRED), "credential leaked into the error");
    return err.problems.join(" | ");
  }
  return "";
};

test("a valid file loads; comments and blanks are fine; the public view omits the credential", () => {
  const b = parseBootstrap(`# comment\n\n${file({ REACH_ROOTS: JSON.stringify([anchor, evil]) })}\n`);
  assert.equal(b.clientId, "laptop-1");
  assert.deepEqual(b.anchors, [anchor, evil]);
  assert.equal(b.credential(), CRED);
  for (const dump of [JSON.stringify(b), JSON.stringify(b.publicView()), String(Object.keys(b)), JSON.stringify({ ...b })]) assert.ok(!dump.includes(CRED));
});

test("grammar: duplicates, unknown keys, malformed lines and missing fields are rejected", () => {
  assert.match(problems(file() + "\nREACH_CLIENT_ID=other"), /duplicate key REACH_CLIENT_ID/);
  assert.match(problems(file() + "\nEXTRA=1"), /unknown key/);
  assert.match(problems(file() + "\nnot a pair"), /expected KEY=VALUE/);
  assert.match(problems(file({ REACH_SERVER_URL: undefined, REACH_CLIENT_CREDENTIAL: undefined })), /missing REACH_SERVER_URL.*missing REACH_CLIENT_CREDENTIAL/);
  assert.match(problems(file({ REACH_ROOTS: "[" })), /not valid JSON/);
  assert.match(problems(file({ REACH_ROOTS: "[]" })), /non-empty/);
  assert.match(problems(file({ REACH_ROOTS: `${anchor}:${evil}` })), /not valid JSON/);
});

test("no interpolation: a $VAR value stays literal data", () => {
  assert.equal(parseBootstrap(file({ REACH_CLIENT_ID: "$HOME" })).clientId, "$HOME");
});

test("endpoint: wss only; ws needs the explicit option; no other scheme, userinfo, query or fragment", () => {
  assert.equal(problems(file({ REACH_SERVER_URL: "wss://s.example" })), "");
  assert.match(problems(file({ REACH_SERVER_URL: "ws://localhost:1" })), /wss/);
  assert.equal(problems(file({ REACH_SERVER_URL: "ws://localhost:1" }), { allowInsecureWs: true }), "");
  for (const url of ["https://s.example", "http://s.example", "file:///etc/x", "nonsense"]) assert.ok(problems(file({ REACH_SERVER_URL: url }), { allowInsecureWs: true }), url);
  assert.match(problems(file({ REACH_SERVER_URL: "wss://u:p@s.example" })), /credentials/);
  assert.match(problems(file({ REACH_SERVER_URL: "wss://s.example/?token=abc" })), /query/);
  assert.match(problems(file({ REACH_SERVER_URL: "wss://s.example/#x" })), /query or fragment/);
});

test("identity values use the shared schemas", () => {
  assert.match(problems(file({ REACH_CLIENT_ID: "a\u0001b" })), /REACH_CLIENT_ID is invalid/);
  assert.match(problems(file({ REACH_CLIENT_CREDENTIAL: "x".repeat(1025) })), /REACH_CLIENT_CREDENTIAL is invalid/);
});

test("anchors: relative, missing, file-valued and duplicate (also via symlink) are rejected; realpath is stored", () => {
  assert.match(problems(file({ REACH_ROOTS: '["rel/path"]' })), /not an absolute/);
  assert.match(problems(file({ REACH_ROOTS: JSON.stringify([path.join(base, "nope")]) })), /existing directory/);
  const f = path.join(base, "plain.txt");
  writeFileSync(f, "x");
  assert.match(problems(file({ REACH_ROOTS: JSON.stringify([f]) })), /existing directory/);
  assert.match(problems(file({ REACH_ROOTS: JSON.stringify([anchor, aliasOfAnchor]) })), /duplicate anchors/);
  assert.deepEqual(parseBootstrap(file({ REACH_ROOTS: JSON.stringify([aliasOfAnchor]) })).anchors, [anchor]);
});

test("file permissions: 0600 and 0400 load; group/other access is refused; windows skips the mode check", () => {
  const f = path.join(base, "client.env");
  writeFileSync(f, file());
  for (const [mode, ok] of [[0o600, true], [0o400, true], [0o640, false], [0o604, false], [0o660, false], [0o644, false]] as const) {
    chmodSync(f, mode);
    if (ok) assert.equal(loadBootstrap(f).clientId, "laptop-1", mode.toString(8));
    else assert.throws(() => loadBootstrap(f), (e: unknown) => e instanceof BootstrapError && /group or others/.test(e.message) && !e.message.includes(CRED), mode.toString(8));
  }
  assert.equal(loadBootstrap(f, { platform: "win32" }).clientId, "laptop-1");
  assert.throws(() => loadBootstrap(path.join(base, "missing.env")), BootstrapError);
});

const policy = (root: string, extra: object = {}) => ({ project_id: "p1", physical_root: root, mode: "read_only", ...extra });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof FsError ? e.code : e instanceof Error ? e.name : "?";
  }
  return "NO_ERROR";
};

test("effective policy: anchor itself and nested roots are accepted, canonicalised", () => {
  assert.equal(acceptEffectivePolicy([anchor], policy(anchor)).physical_root, anchor);
  assert.equal(acceptEffectivePolicy([anchor], policy(path.join(anchor, "proj"))).physical_root, path.join(anchor, "proj"));
  assert.equal(acceptEffectivePolicy([anchor], policy(path.join(anchor, "inside-link"))).physical_root, path.join(anchor, "proj"));
  assert.equal(acceptEffectivePolicy([anchor], policy(path.join(anchor, "proj", "..", "proj"))).physical_root, path.join(anchor, "proj"));
});

test("effective policy: outside, sibling-prefix, symlink escape, missing and file roots are refused", () => {
  assert.equal(code(() => acceptEffectivePolicy([anchor], policy(outside))), "OUTSIDE_ROOT");
  assert.equal(code(() => acceptEffectivePolicy([anchor], policy(evil))), "OUTSIDE_ROOT", "prefix collision");
  assert.equal(code(() => acceptEffectivePolicy([anchor], policy(path.join(anchor, "escape")))), "OUTSIDE_ROOT", "symlink escape");
  assert.equal(code(() => acceptEffectivePolicy([anchor], policy(path.join(anchor, "..")))), "OUTSIDE_ROOT");
  assert.equal(code(() => acceptEffectivePolicy([anchor], policy(path.join(anchor, "nope")))), "NOT_FOUND");
  assert.equal(code(() => acceptEffectivePolicy([anchor], policy(path.join(base, "plain.txt")))), "NOT_DIRECTORY");
  assert.equal(acceptEffectivePolicy([anchor, evil], policy(evil)).physical_root, evil, "any one anchor is enough");
});

test("effective policy schema is strict: no unknown fields, invalid mode, limits or globs; the Client adds none", () => {
  const ok = policy("/r", { writable_globs: ["docs/**"], deny_globs: ["*.key"], limits: { maxReadLines: 100 } });
  assert.ok(EffectiveProjectPolicy.safeParse(ok).success);
  for (const bad of [{ allow: ["x"] }, { mode: "admin" }, { limits: { maxReadLines: 0 } }, { limits: { bogus: 1 } }, { deny_globs: [""] }, { project_id: "" }]) {
    assert.equal(EffectiveProjectPolicy.safeParse({ ...ok, ...bad }).success, false, JSON.stringify(bad));
  }
  assert.equal(code(() => acceptEffectivePolicy([anchor], { ...policy(anchor), extra: 1 })), "ZodError");
});

test("physical_root must be an explicit absolute host path: relative roots never depend on the process cwd", () => {
  for (const rel of ["proj", "./proj", "../proj", "proj/sub", "C:proj", ""]) assert.equal(EffectiveProjectPolicy.safeParse(policy(rel)).success, false, rel);
  for (const abs of ["/srv/p", "C:\\Work\\p", "c:/work/p", "\\\\server\\share\\p"]) assert.equal(EffectiveProjectPolicy.safeParse(policy(abs)).success, true, abs);
  const before = process.cwd();
  process.chdir(anchor);
  try {
    assert.equal(code(() => acceptEffectivePolicy([anchor], policy("proj"))), "ZodError", "proj exists under the cwd and the anchor, yet is refused");
    assert.equal(code(() => acceptEffectivePolicy([anchor], policy("./proj"))), "ZodError");
  } finally {
    process.chdir(before);
  }
});
