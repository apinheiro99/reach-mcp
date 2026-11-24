import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acceptEffectivePolicy, BootstrapError, loadBootstrap, parseBootstrap } from "../src/index.ts";
import { EffectiveProjectPolicy } from "@reach-mcp/shared/wire";
import { generateIdentityKey, machineUuid, verifyClientAuth } from "@reach-mcp/shared/identity";
import { FsError } from "@reach-mcp/shared/filesystem";

const KEY = generateIdentityKey();
const NATIVE_ID = "0123456789abcdef0123456789abcdef";
/** The Client private key: it must never appear in an error, view or dump. */
const CRED = KEY.privateKey;
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
  Object.entries({ REACH_SERVER_URL: "wss://server.example/ws", REACH_CLIENT_ID: "laptop-1", REACH_CLIENT_IDENTITY_KEY: CRED, REACH_ROOTS: JSON.stringify([anchor]), ...over })
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
const problems = (text: string, opts = {}) => {
  try {
    parseBootstrap(text, opts);
  } catch (err) {
    assert.ok(err instanceof BootstrapError);
    assert.ok(!err.message.includes(CRED), "private key leaked into the error");
    return err.problems.join(" | ");
  }
  return "";
};

test("a valid file loads; comments and blanks are fine; the public view omits the private key", () => {
  const b = parseBootstrap(`# comment\n\n${file({ REACH_ROOTS: JSON.stringify([anchor, evil]) })}\n`);
  assert.equal(b.clientId, "laptop-1");
  assert.deepEqual(b.anchors, [anchor, evil]);
  assert.equal(b.publicKey(), KEY.publicKey);
  assert.equal(verifyClientAuth(KEY.publicKey, "n".repeat(43), "c".repeat(43), "laptop-1", b.sign("n".repeat(43), "c".repeat(43))), true, "it signs without exposing the key");
  for (const dump of [JSON.stringify(b), JSON.stringify(b.publicView()), String(Object.keys(b)), JSON.stringify({ ...b })]) assert.ok(!dump.includes(CRED));
});

test("grammar: duplicates, unknown keys, malformed lines and missing fields are rejected", () => {
  assert.match(problems(file() + "\nREACH_CLIENT_ID=other"), /duplicate key REACH_CLIENT_ID/);
  assert.match(problems(file() + "\nEXTRA=1"), /unknown key/);
  assert.match(problems(file() + "\nnot a pair"), /expected KEY=VALUE/);
  assert.match(problems(file({ REACH_SERVER_URL: undefined, REACH_CLIENT_IDENTITY_KEY: undefined })), /missing REACH_SERVER_URL.*missing REACH_CLIENT_IDENTITY_KEY/);
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
  assert.match(problems(file({ REACH_CLIENT_IDENTITY_KEY: "x".repeat(64) })), /REACH_CLIENT_IDENTITY_KEY is invalid/);
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

test("first run: createIdentity generates the client_id and Ed25519 key once, writes them 0600 into the bootstrap file and never again", () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "reach-first-run-")), "bootstrap.env");
  writeFileSync(f, `REACH_SERVER_URL=wss://server.example/ws\nREACH_ROOTS=${JSON.stringify([anchor])}\n`, { mode: 0o600 });
  assert.throws(() => loadBootstrap(f), (e: unknown) => e instanceof BootstrapError && /missing REACH_CLIENT_ID/.test(e.message), "without the first-run option nothing is generated or written");
  const first = loadBootstrap(f, { createIdentity: true, readNativeMachineId: () => NATIVE_ID });
  const text = readFileSync(f, "utf8");
  assert.match(text, /REACH_CLIENT_ID=\S+\nREACH_CLIENT_IDENTITY_KEY=\S+\n$/);
  assert.equal(statSync(f).mode & 0o077, 0, "the identity file stays private");
  const second = loadBootstrap(f, { createIdentity: true, readNativeMachineId: () => NATIVE_ID });
  assert.equal(readFileSync(f, "utf8"), text, "the identity is generated once");
  assert.deepEqual([second.clientId, second.publicKey()], [first.clientId, first.publicKey()]);
  assert.ok(!JSON.stringify(first.publicView()).includes(/REACH_CLIENT_IDENTITY_KEY=(\S+)/.exec(text)![1]!));
  const open = path.join(path.dirname(f), "open.env");
  writeFileSync(open, readFileSync(f, "utf8").split("\n").filter((l) => !l.startsWith("REACH_CLIENT")).join("\n"), { mode: 0o644 });
  assert.throws(() => loadBootstrap(open, { createIdentity: true, readNativeMachineId: () => NATIVE_ID }), (e: unknown) => e instanceof BootstrapError && /group or others/.test(e.message), "a file open to others never receives a key");
  assert.ok(!readFileSync(open, "utf8").includes("REACH_CLIENT_IDENTITY_KEY"));
});

test("prepareRotation: a candidate pair changes nothing until commit, then replaces only the private key line, atomically, 0600", () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "reach-rotate-boot-")), "bootstrap.env");
  const text = `# kept\nREACH_SERVER_URL=wss://server.example/ws\nREACH_CLIENT_ID=laptop-1\nREACH_CLIENT_IDENTITY_KEY=${CRED}\nREACH_ROOTS=${JSON.stringify([anchor])}\n`;
  writeFileSync(f, text, { mode: 0o600 });
  const boot = loadBootstrap(f);
  const prepared = boot.prepareRotation();
  const next = prepared.publicKey;
  assert.notEqual(next, KEY.publicKey);
  assert.equal(boot.publicKey(), KEY.publicKey, "the valid identity is untouched by a candidate");
  assert.equal(readFileSync(f, "utf8"), text, "and so is the file");
  prepared.commit();
  assert.equal(boot.publicKey(), next, "the in-memory identity is the new one");
  const after = readFileSync(f, "utf8");
  const newKey = /REACH_CLIENT_IDENTITY_KEY=(\S+)/.exec(after)![1]!;
  assert.notEqual(newKey, CRED);
  assert.equal(after.replace(newKey, CRED), text, "every other line, comment and id is untouched");
  assert.equal(statSync(f).mode & 0o077, 0, "still private");
  assert.equal(loadBootstrap(f).publicKey(), next, "a restart loads the rotated identity");
  assert.equal(verifyClientAuth(next, "N".repeat(43), "C".repeat(43), "laptop-1", boot.sign("N".repeat(43), "C".repeat(43))), true, "signatures now come from the new key");
  assert.throws(() => parseBootstrap(text, {}, undefined).prepareRotation(), (e: unknown) => e instanceof BootstrapError && !String(e).includes(CRED), "a bootstrap with no file cannot rotate");
});

test("first run: the client_id is the Machine UUID of the OS machine, so recreating the local state keeps the same logical Client with a new key", () => {
  const first = path.join(mkdtempSync(path.join(tmpdir(), "reach-machine-a-")), "bootstrap.env");
  const second = path.join(mkdtempSync(path.join(tmpdir(), "reach-machine-b-")), "bootstrap.env");
  const other = path.join(mkdtempSync(path.join(tmpdir(), "reach-machine-c-")), "bootstrap.env");
  for (const f of [first, second, other]) writeFileSync(f, `REACH_SERVER_URL=wss://server.example/ws\nREACH_ROOTS=${JSON.stringify([anchor])}\n`, { mode: 0o600 });
  const a = loadBootstrap(first, { createIdentity: true, readNativeMachineId: () => NATIVE_ID });
  const reinstalled = loadBootstrap(second, { createIdentity: true, readNativeMachineId: () => NATIVE_ID });
  const another = loadBootstrap(other, { createIdentity: true, readNativeMachineId: () => "fedcba9876543210fedcba9876543210" });
  assert.equal(a.clientId, machineUuid(NATIVE_ID));
  assert.equal(reinstalled.clientId, a.clientId, "same machine, same client_id after a reinstall");
  assert.notEqual(reinstalled.publicKey(), a.publicKey(), "authentication is a separate, fresh key");
  assert.notEqual(another.clientId, a.clientId);
});

test("first run: an unreadable native machine identifier fails closed, writes nothing and never falls back to the hostname", () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "reach-machine-fail-")), "bootstrap.env");
  const text = `REACH_SERVER_URL=wss://server.example/ws\nREACH_ROOTS=${JSON.stringify([anchor])}\n`;
  writeFileSync(f, text, { mode: 0o600 });
  for (const read of [() => { throw new Error("denied"); }, () => "not-an-id"]) {
    assert.throws(() => loadBootstrap(f, { createIdentity: true, readNativeMachineId: read }), (e: unknown) => e instanceof BootstrapError && /Machine UUID/.test(e.message));
  }
  assert.equal(readFileSync(f, "utf8"), text);
});

test("loadBootstrap reports the Machine UUID of this machine for correlation, keeps a legacy client_id untouched, and still loads when the native id is unreadable", () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "reach-legacy-")), "bootstrap.env");
  writeFileSync(f, `REACH_SERVER_URL=wss://server.example/ws\nREACH_CLIENT_ID=laptop-1\nREACH_CLIENT_IDENTITY_KEY=${CRED}\nREACH_ROOTS=${JSON.stringify([anchor])}\n`, { mode: 0o600 });
  const withId = loadBootstrap(f, { readNativeMachineId: () => NATIVE_ID });
  assert.equal(withId.clientId, "laptop-1", "an existing client_id is never rewritten");
  assert.equal(withId.machineUuid, machineUuid(NATIVE_ID));
  const unreadable = loadBootstrap(f, { readNativeMachineId: () => { throw new Error("denied"); } });
  assert.equal(unreadable.machineUuid, undefined);
  assert.equal(unreadable.clientId, "laptop-1");
});

// ---- ADR-0005: the Bootstrap owns the pinned Server key, the highest accepted release epoch and digest, and the rotation generation ----
const SERVER_PIN = generateIdentityKey().publicKey;
const DIGEST = "d".repeat(64);

test("trust lines are optional (a Client from before pinning has none), parsed strictly, and never echo a bad value", () => {
  const none = parseBootstrap(file());
  assert.deepEqual(none.trust(), { serverKey: null, releaseEpoch: 0, releaseDigest: null, rotationGeneration: 0 });
  const full = parseBootstrap(`${file()}\nREACH_SERVER_TRUST_KEY=${SERVER_PIN}\nREACH_RELEASE_EPOCH=7\nREACH_RELEASE_DIGEST=${DIGEST}\nREACH_ROTATION_GENERATION=0\n`);
  assert.deepEqual(full.trust(), { serverKey: SERVER_PIN, releaseEpoch: 7, releaseDigest: DIGEST, rotationGeneration: 0 });
  for (const line of ["REACH_SERVER_TRUST_KEY=short", "REACH_RELEASE_EPOCH=0", "REACH_RELEASE_EPOCH=-1", "REACH_RELEASE_EPOCH=1.5", "REACH_RELEASE_EPOCH=abc", "REACH_RELEASE_DIGEST=ZZ", "REACH_ROTATION_GENERATION=-1"]) {
    assert.throws(() => parseBootstrap(`${file()}\n${line}\n`), (e: unknown) => e instanceof BootstrapError && !String(e).includes(line.split("=")[1]!), line);
  }
  assert.throws(() => parseBootstrap(`${file()}\nREACH_SERVER_TRUST_KEY=${SERVER_PIN}\nREACH_SERVER_TRUST_KEY=${SERVER_PIN}\n`), BootstrapError, "duplicates are refused like every other key");
});

test("pinning and accepting a release rewrite only their own lines, atomically, keeping every other line and the file private", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "reach-trust-bs-"));
  const f = path.join(dir, "bootstrap.env");
  const text = `# keep me\n${file()}\n`;
  writeFileSync(f, text, { mode: 0o600 });
  const b = loadBootstrap(f, { allowInsecureWs: true });
  b.pinServerKey(SERVER_PIN, 0);
  b.acceptRelease(3, DIGEST);
  const after = readFileSync(f, "utf8");
  assert.ok(after.startsWith(text.trimEnd()), "every earlier line, comment and the private key are untouched");
  assert.equal(statSync(f).mode & 0o077, 0);
  assert.deepEqual(loadBootstrap(f, { allowInsecureWs: true }).trust(), { serverKey: SERVER_PIN, releaseEpoch: 3, releaseDigest: DIGEST, rotationGeneration: 0 }, "a restart sees it");
  const next = generateIdentityKey().publicKey;
  b.pinServerKey(next, 1);
  b.acceptRelease(4, "e".repeat(64));
  const again = readFileSync(f, "utf8");
  for (const key of ["REACH_SERVER_TRUST_KEY", "REACH_RELEASE_EPOCH", "REACH_RELEASE_DIGEST", "REACH_ROTATION_GENERATION"]) assert.equal(again.match(new RegExp(`^${key}=`, "gm"))?.length, 1, `${key} appears once, replaced in place`);
  assert.equal(loadBootstrap(f, { allowInsecureWs: true }).trust().serverKey, next);
  assert.ok(!JSON.stringify(b).includes(CRED) && !JSON.stringify(b.publicView()).includes(CRED), "the private key is still never visible");
});

test("a pin that cannot be written leaves the active trust state unchanged", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "reach-trust-bs-"));
  const f = path.join(dir, "bootstrap.env");
  writeFileSync(f, file(), { mode: 0o600 });
  const b = loadBootstrap(f, { allowInsecureWs: true });
  rmSync(f);
  assert.throws(() => b.pinServerKey(SERVER_PIN, 0));
  assert.equal(b.trust().serverKey, null, "memory never runs ahead of the file");
});
