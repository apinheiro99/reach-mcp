import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigError, hashCredential, ServerConfigStore } from "../src/index.ts";
import { PolicySync } from "../../shared/src/wire/index.ts";

const dir = mkdtempSync(path.join(tmpdir(), "reach-server-config-"));
const MARKER_A = "cred-marker-" + "Aq83Lm";
const MARKER_B = "cred-marker-" + "Bz51Pk";

const MCP = { mcp_bearer_sha256: hashCredential("mcp-marker-" + "Kd40") };
const project = (id: string, root: string, extra: object = {}) => ({ project_id: id, physical_root: root, mode: "read_only", ...extra });
const client = (id: string, marker: string | null, projects: object[], extra: object = {}) => ({
  client_id: id,
  enabled: true,
  ...(marker ? { credential_sha256: hashCredential(marker) } : {}),
  projects,
  ...extra,
});
const valid = () => ({
  mcp_bearer_sha256: hashCredential("mcp-marker-" + "Kd40"),
  clients: [
    client("laptop", MARKER_A, [project("web", "/srv/web", { mode: "read_write", writable_globs: ["docs/**"], deny_globs: ["*.key"], limits: { maxReadLines: 100 } }), project("api", "C:\\work\\api")], { display_name: "Work laptop" }),
    client("desktop", MARKER_B, [project("web", "/home/u/web")]),
  ],
});
let n = 0;
const write = (config: unknown, raw?: string): string => {
  const file = path.join(dir, `config-${n++}.json`);
  writeFileSync(file, raw ?? JSON.stringify(config));
  return file;
};
const problems = (fn: () => void): string => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ConfigError, "a ConfigError, not a raw exception");
    return err.problems.join(" | ");
  }
  return "";
};
const load = (config: unknown, raw?: string) => problems(() => new ServerConfigStore(write(config, raw)).loadInitial());

test("a valid file loads; the same project name under two Clients is allowed; roots are not checked on this host", () => {
  const store = new ServerConfigStore(write(valid()));
  store.loadInitial();
  assert.equal(store.isActive(), true);
  assert.deepEqual(store.snapshot().clients.map((c) => [c.client_id, c.projects.map((p) => p.project_id)]), [["laptop", ["web", "api"]], ["desktop", ["web"]]]);
});

test("strictness: unknown keys, malformed JSON, bad ids, relative roots, bad modes, globs, limits and digests are refused", () => {
  const base = valid();
  const withClient = (patch: object) => ({ ...MCP, clients: [{ ...base.clients[0], ...patch }] });
  const withProject = (patch: object) => ({ ...MCP, clients: [{ ...base.clients[0], projects: [{ ...(base.clients[0]!.projects[0] as object), ...patch }] }] });
  assert.match(load(null, "{ not json"), /not valid JSON/);
  assert.ok(load({ ...base, extra: 1 }));
  assert.ok(load(withClient({ extra: 1 })));
  assert.ok(load(withClient({ client_id: "" })));
  assert.ok(load(withClient({ client_id: "a\u0001b" })));
  assert.ok(load(withClient({ credential_sha256: "ABC" })));
  assert.ok(load(withClient({ credential_sha256: hashCredential("x").toUpperCase() })), "digest must be canonical lowercase");
  assert.ok(load(withClient({ enabled: "yes" })));
  assert.ok(load(withProject({ physical_root: "relative/path" })));
  assert.ok(load(withProject({ mode: "admin" })));
  assert.ok(load(withProject({ deny_globs: [""] })));
  assert.ok(load(withProject({ limits: { maxReadLines: 0 } })));
  assert.ok(load(withProject({ unknown: true })));
  assert.ok(load({ clients: "none" }));
});

test("uniqueness: duplicate client_id and duplicate project_id inside a Client are refused", () => {
  const base = valid();
  assert.match(load({ ...MCP, clients: [base.clients[0], { ...base.clients[1], client_id: "laptop" }] }), /duplicate client_id/);
  assert.match(load({ ...MCP, clients: [client("c", MARKER_A, [project("p", "/a"), project("p", "/b")])] }), /duplicate project_id within a client/);
});

test("an enabled Client needs a credential digest; a disabled one may keep or lack it", () => {
  assert.match(load({ ...MCP, clients: [client("c", null, [])] }), /needs a credential digest/);
  assert.equal(load({ ...MCP, clients: [client("c", null, [], { enabled: false })] }), "");
  assert.equal(load({ ...MCP, clients: [client("c", MARKER_A, [], { enabled: false })] }), "");
});

test("initial load failure leaves nothing active", () => {
  const store = new ServerConfigStore(write(null, "{ broken"));
  assert.throws(() => store.loadInitial(), ConfigError);
  assert.equal(store.isActive(), false);
  assert.throws(() => store.snapshot(), ConfigError);
  assert.throws(() => new ServerConfigStore(path.join(dir, "missing.json")).loadInitial(), ConfigError);
});

test("an invalid reload keeps the previous snapshot exactly; a valid reload replaces everything, including removals", () => {
  const file = write(valid());
  const store = new ServerConfigStore(file);
  store.loadInitial();
  const before = JSON.stringify(store.snapshot());
  const policiesBefore = JSON.stringify(store.effectivePoliciesFor("laptop"));
  writeFileSync(file, "{ truncated");
  assert.throws(() => store.reload(), ConfigError);
  writeFileSync(file, JSON.stringify({ ...MCP, clients: [client("laptop", MARKER_A, [project("web", "/srv/web"), project("web", "/dup")])] }));
  assert.throws(() => store.reload(), ConfigError);
  assert.equal(JSON.stringify(store.snapshot()), before, "the last good snapshot is untouched");
  assert.equal(JSON.stringify(store.effectivePoliciesFor("laptop")), policiesBefore);
  assert.match(readFileSync(file, "utf8"), /web.*dup/s, "the file is never rewritten or repaired");
  writeFileSync(file, JSON.stringify({ ...MCP, clients: [client("laptop", MARKER_A, [project("only", "/srv/only")])] }));
  store.reload();
  assert.deepEqual(store.snapshot().clients.map((c) => c.client_id), ["laptop"], "desktop was removed");
  assert.deepEqual(store.effectivePoliciesFor("laptop")?.map((p) => p.project_id), ["only"]);
  assert.equal(store.effectivePoliciesFor("desktop"), null);
});

test("effective policies are shared-valid, carry only operational fields, and exist only for an enabled registered Client", () => {
  const store = new ServerConfigStore(write({ ...MCP, clients: [...valid().clients, client("off", MARKER_A, [project("p", "/x")], { enabled: false })] }));
  store.loadInitial();
  const policies = store.effectivePoliciesFor("laptop")!;
  assert.equal(PolicySync.safeParse({ kind: "policy_sync", policies }).success, true);
  assert.deepEqual(policies[0], { project_id: "web", physical_root: "/srv/web", mode: "read_write", writable_globs: ["docs/**"], deny_globs: ["*.key"], limits: { maxReadLines: 100 } });
  const text = JSON.stringify(policies);
  assert.ok(!text.includes("credential") && !text.includes("display_name") && !text.includes("Work laptop"));
  assert.equal(store.effectivePoliciesFor("off"), null, "disabled");
  assert.equal(store.effectivePoliciesFor("nobody"), null, "unknown");
  assert.equal(store.credentialDigestFor("off"), null);
  assert.equal(store.credentialDigestFor("laptop"), hashCredential(MARKER_A));
  policies[0]!.mode = "read_only";
  assert.equal(store.effectivePoliciesFor("laptop")![0]!.mode, "read_write", "callers get copies");
});

test("credentials: the hash is stable lowercase SHA-256; no plaintext or digest appears in the public view or in errors", () => {
  assert.equal(hashCredential(MARKER_A), hashCredential(MARKER_A));
  assert.match(hashCredential(MARKER_A), /^[0-9a-f]{64}$/);
  assert.notEqual(hashCredential(MARKER_A), hashCredential(MARKER_B));
  const file = write(valid());
  const store = new ServerConfigStore(file);
  store.loadInitial();
  const publicText = JSON.stringify(store.snapshot());
  for (const secret of [MARKER_A, MARKER_B, hashCredential(MARKER_A), "credential_sha256"]) assert.ok(!publicText.includes(secret), "public snapshot is free of credential material");
  assert.ok(!readFileSync(file, "utf8").includes(MARKER_A), "the file holds only the digest");
  writeFileSync(file, JSON.stringify({ ...MCP, clients: [client("c", MARKER_A, [], { credential_sha256: hashCredential(MARKER_A).toUpperCase() })] }));
  const message = problems(() => store.reload());
  assert.ok(message && !message.includes(hashCredential(MARKER_A)) && !message.includes(MARKER_A), "errors never echo values");
});

test("the config module holds no network, session, watcher, database or UI code", () => {
  const src = path.join(import.meta.dirname, "..", "src");
  const text = readFileSync(path.join(src, "config.ts"), "utf8");
  assert.ok(!/node:(net|http|https|tls|dgram|child_process)\b|\bws\b|fs\.watch|\bwatch\(|sqlite|yaml/i.test(text));
  assert.ok(!/\/reach\/|reach-private/.test(text), "no hardcoded private path");
});

test("the MCP bearer digest is required and strict, stays out of the public snapshot, and is exposed only through its accessor", () => {
  const file = write(valid());
  const store = new ServerConfigStore(file);
  store.loadInitial();
  assert.equal(store.mcpBearerDigest(), valid().mcp_bearer_sha256);
  assert.ok(!JSON.stringify(store.snapshot()).includes("mcp_bearer"), "not in the public view");
  assert.match(load({ clients: [] }), /mcp_bearer_sha256/);
  assert.ok(load({ ...MCP, mcp_bearer_sha256: "ABC", clients: [] }));
  writeFileSync(file, JSON.stringify({ clients: [] }));
  assert.throws(() => store.reload(), ConfigError);
  assert.equal(store.mcpBearerDigest(), valid().mcp_bearer_sha256, "a bad reload keeps the previous digest");
});

test("activateCandidate: the first activation creates the file, activates it, and a fresh store loads it", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "reach-activate-")), "nested", "config.json");
  const store = new ServerConfigStore(file);
  assert.equal(store.isActive(), false);
  store.activateCandidate(valid());
  assert.equal(store.isActive(), true);
  const fresh = new ServerConfigStore(file);
  fresh.loadInitial();
  assert.deepEqual(fresh.snapshot(), store.snapshot());
  assert.equal(statSync(file).mode & 0o077, 0, "the file is private to its owner");
});

test("activateCandidate: an invalid candidate changes neither the file nor the active snapshot", () => {
  const file = write(valid());
  const store = new ServerConfigStore(file);
  store.loadInitial();
  const before = readFileSync(file, "utf8");
  const bad = { ...valid(), clients: [client("x", null, [])] };
  assert.throws(() => store.activateCandidate(bad), ConfigError);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(store.snapshot().clients.length, 2);
});

test("activateCandidate: a failed write leaves the previous active snapshot intact and names no path", () => {
  const own = mkdtempSync(path.join(tmpdir(), "reach-failwrite-"));
  const file = path.join(own, "config.json");
  writeFileSync(file, JSON.stringify(valid()));
  const store = new ServerConfigStore(file);
  store.loadInitial();
  rmSync(own, { recursive: true });
  writeFileSync(own, "a file where the directory was"); // the write can no longer succeed
  const other = { ...valid(), clients: [client("solo", MARKER_A, [project("p", "/srv/p")])] };
  assert.throws(() => store.activateCandidate(other), (e: unknown) => e instanceof ConfigError && !e.message.includes(file));
  assert.equal(store.snapshot().clients.length, 2, "no partial active change");
});

test("applyEdit: keeps stored digests by client_id, hashes a new bearer, and never returns a digest or the plaintext", () => {
  const file = write(valid());
  const store = new ServerConfigStore(file);
  store.loadInitial();
  const bearer = "new-bearer-" + "Qr72Hs9x";
  const edit = { mcp_bearer: bearer, clients: store.snapshot().clients.map((c) => ({ ...c, display_name: "renamed" })) };
  store.applyEdit(edit);
  assert.equal(store.credentialDigestFor("laptop"), hashCredential(MARKER_A), "digest carried over");
  assert.equal(store.mcpBearerDigest(), hashCredential(bearer));
  const stored = readFileSync(file, "utf8");
  assert.ok(!stored.includes(bearer), "the plaintext is never persisted");
  const view = JSON.stringify(store.editableView());
  assert.ok(!view.includes(hashCredential(MARKER_A)) && !view.includes("sha256"), "the editable view carries no digest");
  assert.equal(store.editableView().clients[0]?.has_credential, true);
  assert.throws(() => store.applyEdit({ clients: [] , extra: 1 }), ConfigError);
});

test("applyEdit: the first configuration needs a bearer, and validation errors never echo a submitted secret", () => {
  const store = new ServerConfigStore(path.join(mkdtempSync(path.join(tmpdir(), "reach-first-")), "config.json"));
  assert.throws(() => store.applyEdit({ clients: [] }), (e: unknown) => e instanceof ConfigError && e.problems[0]?.startsWith("mcp_bearer"));
  const secret = "short secret";
  assert.throws(() => store.applyEdit({ mcp_bearer: secret, clients: [] }), (e: unknown) => e instanceof ConfigError && !e.message.includes(secret));
  assert.equal(store.isActive(), false);
  store.applyEdit({ mcp_bearer: "first-bearer-" + "Lk90Zt", clients: [] });
  assert.equal(store.isActive(), true);
});

test("issueCredential: returns a strong plaintext once and stores only its digest", () => {
  const file = write(valid());
  const store = new ServerConfigStore(file);
  store.loadInitial();
  const credential = store.issueCredential("desktop");
  assert.ok(credential.length >= 40);
  assert.equal(store.credentialDigestFor("desktop"), hashCredential(credential));
  assert.ok(!readFileSync(file, "utf8").includes(credential));
  assert.notEqual(store.issueCredential("desktop"), credential, "each call is a new credential");
  assert.throws(() => store.issueCredential("nobody"), ConfigError);
});

test("logging settings: defaults when omitted, bounded, editable through the one owner and persisted", () => {
  const file = write(valid());
  const store = new ServerConfigStore(file);
  assert.deepEqual(store.loggingSettings(), { max_bytes: 10 * 1024 * 1024, retention_days: 5 }, "defaults while inactive");
  store.loadInitial();
  assert.deepEqual(store.loggingSettings(), { max_bytes: 10 * 1024 * 1024, retention_days: 5 }, "defaults when the file omits them");
  for (const bad of [{ max_bytes: 10, retention_days: 5 }, { max_bytes: 2048, retention_days: 0 }, { max_bytes: 2048, retention_days: 366 }, { max_bytes: 2048.5, retention_days: 5 }, { max_bytes: 2048, retention_days: 5, extra: 1 }]) {
    assert.throws(() => store.applyEdit({ logging: bad, clients: store.snapshot().clients }), ConfigError);
  }
  store.applyEdit({ logging: { max_bytes: 4096, retention_days: 9 }, clients: store.snapshot().clients });
  assert.deepEqual(store.loggingSettings(), { max_bytes: 4096, retention_days: 9 });
  assert.deepEqual(store.editableView().logging, { max_bytes: 4096, retention_days: 9 });
  const fresh = new ServerConfigStore(file);
  fresh.loadInitial();
  assert.deepEqual(fresh.loggingSettings(), { max_bytes: 4096, retention_days: 9 }, "persisted");
  store.applyEdit({ clients: store.snapshot().clients });
  assert.deepEqual(store.loggingSettings(), { max_bytes: 4096, retention_days: 9 }, "an edit without logging keeps it");
  assert.equal("logging" in store.validateEdit({ clients: store.snapshot().clients }), false, "an AI proposal carries no logging settings");
  assert.throws(() => store.validateEdit({ logging: { max_bytes: 4096, retention_days: 9 }, clients: [] }), ConfigError);
});
