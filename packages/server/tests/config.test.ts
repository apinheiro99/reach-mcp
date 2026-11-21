import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigError, hashCredential, ServerConfigStore } from "../src/index.ts";
import { newIdentity } from "./identity-fixture.ts";
import { PolicySync } from "@reach-mcp/shared/wire";

const dir = mkdtempSync(path.join(tmpdir(), "reach-server-config-"));
const KEY_A = newIdentity();
const KEY_B = newIdentity();
const MARKER_A = KEY_A.publicKey;
const MARKER_B = KEY_B.publicKey;

const MCP = { mcp_bearer_sha256: hashCredential("mcp-marker-" + "Kd40") };
const project = (id: string, root: string, extra: object = {}) => ({ project_id: id, physical_root: root, mode: "read_only", ...extra });
const client = (id: string, key: string | null, projects: object[], extra: object = {}) => ({
  client_id: id,
  enabled: true,
  ...(key ? { public_key: key } : {}),
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
  assert.ok(load(withClient({ public_key: "ABC" })));
  assert.ok(load(withClient({ public_key: MARKER_A + "x" })), "a public key is exactly 32 bytes of base64url");
  assert.ok(load(withClient({ credential_sha256: "a".repeat(64) })), "the shared credential digest field no longer exists");
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

test("an enabled Client needs a public key and keys are unique; a disabled one may keep or lack it", () => {
  assert.match(load({ ...MCP, clients: [client("c", null, [])] }), /needs a public key/);
  assert.match(load({ ...MCP, clients: [client("a", MARKER_A, []), client("b", MARKER_A, [])] }), /duplicate public key/);
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
  const store = new ServerConfigStore(write({ ...MCP, clients: [...valid().clients, client("off", newIdentity().publicKey, [project("p", "/x")], { enabled: false })] }));
  store.loadInitial();
  const policies = store.effectivePoliciesFor("laptop")!;
  assert.equal(PolicySync.safeParse({ kind: "policy_sync", policies }).success, true);
  assert.deepEqual(policies[0], { project_id: "web", physical_root: "/srv/web", mode: "read_write", writable_globs: ["docs/**"], deny_globs: ["*.key"], limits: { maxReadLines: 100 } });
  const text = JSON.stringify(policies);
  assert.ok(!text.includes("public_key") && !text.includes("display_name") && !text.includes("Work laptop"));
  assert.equal(store.effectivePoliciesFor("off"), null, "disabled");
  assert.equal(store.effectivePoliciesFor("nobody"), null, "unknown");
  assert.equal(store.admissionOf("nobody"), null);
  assert.equal(store.admissionOf("laptop")?.publicKey, MARKER_A);
  policies[0]!.mode = "read_only";
  assert.equal(store.effectivePoliciesFor("laptop")![0]!.mode, "read_write", "callers get copies");
});

test("keys: no public key appears in the public snapshot, and the file holds a public key but never a private one", () => {
  const file = write(valid());
  const store = new ServerConfigStore(file);
  store.loadInitial();
  const publicText = JSON.stringify(store.snapshot());
  for (const secret of [MARKER_A, MARKER_B, "public_key", "credential_sha256"]) assert.ok(!publicText.includes(secret), "public snapshot is free of key material");
  assert.ok(!readFileSync(file, "utf8").includes(KEY_A.privateKey), "the file never holds a private key");
  writeFileSync(file, JSON.stringify({ ...MCP, clients: [client("c", MARKER_A, [], { public_key: MARKER_A + "!" })] }));
  const message = problems(() => store.reload());
  assert.ok(message && !message.includes(MARKER_A), "errors never echo values");
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

test("applyEdit: keeps stored public keys by client_id, hashes a new bearer, and never returns a key or the plaintext", () => {
  const file = write(valid());
  const store = new ServerConfigStore(file);
  store.loadInitial();
  const bearer = "new-bearer-" + "Qr72Hs9x";
  const edit = { mcp_bearer: bearer, clients: store.snapshot().clients.map((c) => ({ ...c, display_name: "renamed" })) };
  store.applyEdit(edit);
  assert.equal(store.admissionOf("laptop")?.publicKey, MARKER_A, "public key carried over");
  assert.equal(store.mcpBearerDigest(), hashCredential(bearer));
  const stored = readFileSync(file, "utf8");
  assert.ok(!stored.includes(bearer), "the plaintext is never persisted");
  const view = JSON.stringify(store.editableView());
  assert.ok(!view.includes(MARKER_A) && !view.includes("sha256"), "the editable view carries no key");
  assert.equal(store.editableView().clients[0]?.has_public_key, true);
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

test("registerPendingClient: one atomic write of a new Pending Client with its public key, no project and no access; known ids and reused keys are refused", () => {
  const file = write(valid());
  const store = new ServerConfigStore(file);
  store.loadInitial();
  const fresh = newIdentity();
  store.registerPendingClient("newbox", fresh.publicKey, "New box");
  assert.deepEqual(store.admissionOf("newbox"), { status: "pending", publicKey: fresh.publicKey }, "the key is known in every status");
  assert.equal(store.effectivePoliciesFor("newbox"), null, "Pending has no operational access");
  const stored = readFileSync(file, "utf8");
  assert.ok(stored.includes(fresh.publicKey) && !stored.includes(fresh.privateKey));
  assert.throws(() => store.registerPendingClient("newbox", newIdentity().publicKey), ConfigError, "a known client_id is never registered again");
  assert.throws(() => store.registerPendingClient("other", fresh.publicKey), ConfigError, "a registered public key cannot register a second id");
  assert.equal(store.admissionOf("other"), null);
  assert.equal(store.snapshot().clients.length, 3, "the failed registrations changed nothing");
});

test("lifecycle: Enable authorizes the same identity, Disable keeps identity, key and projects, and replacing a key is one atomic write that frees the old one", () => {
  const file = write(valid());
  const store = new ServerConfigStore(file);
  store.loadInitial();
  const fresh = newIdentity();
  store.registerPendingClient("newbox", fresh.publicKey);
  assert.equal(store.clientSummaries().find((c) => c.client_id === "newbox")?.status, "pending");
  store.setClientEnabled("newbox", true);
  assert.deepEqual(store.effectivePoliciesFor("newbox"), [], "Enabled: authorized, no project yet");
  assert.equal(store.clientSummaries().find((c) => c.client_id === "newbox")?.status, "enabled");
  store.setClientEnabled("newbox", false);
  assert.equal(store.clientSummaries().find((c) => c.client_id === "newbox")?.status, "disabled", "a human decision ends Pending");
  assert.equal(store.admissionOf("newbox")?.publicKey, fresh.publicKey, "Disable keeps the identity");
  store.setClientEnabled("laptop", false);
  store.setClientEnabled("laptop", true);
  assert.equal(store.effectivePoliciesFor("laptop")?.length, 2, "re-enable restores the same identity and projects");
  const next = newIdentity();
  store.replaceClientPublicKey("newbox", next.publicKey);
  assert.equal(store.admissionOf("newbox")?.publicKey, next.publicKey);
  assert.ok(!readFileSync(file, "utf8").includes(fresh.publicKey), "the old key is gone from the file");
  assert.throws(() => store.replaceClientPublicKey("newbox", MARKER_A), ConfigError, "a key already registered cannot be taken");
  assert.throws(() => store.setClientEnabled("nobody", true), ConfigError);
  assert.throws(() => store.replaceClientPublicKey("nobody", next.publicKey), ConfigError);
  const summary = JSON.stringify(store.clientSummaries());
  assert.ok(!summary.includes(next.publicKey) && !summary.includes(MARKER_A), "a summary never carries a public key");
  assert.match(store.clientSummaries()[0]!.fingerprint!, /^ed25519:[0-9a-f]{64}$/);
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
