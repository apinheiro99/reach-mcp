import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigError, hashCredential, ServerConfigStore } from "../src/index.ts";
import { PolicySync } from "../../shared/src/wire/index.ts";

const dir = mkdtempSync(path.join(tmpdir(), "reach-server-config-"));
const MARKER_A = "cred-marker-" + "Aq83Lm";
const MARKER_B = "cred-marker-" + "Bz51Pk";

const project = (id: string, root: string, extra: object = {}) => ({ project_id: id, physical_root: root, mode: "read_only", ...extra });
const client = (id: string, marker: string | null, projects: object[], extra: object = {}) => ({
  client_id: id,
  enabled: true,
  ...(marker ? { credential_sha256: hashCredential(marker) } : {}),
  projects,
  ...extra,
});
const valid = () => ({
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
  const withClient = (patch: object) => ({ clients: [{ ...base.clients[0], ...patch }] });
  const withProject = (patch: object) => ({ clients: [{ ...base.clients[0], projects: [{ ...(base.clients[0]!.projects[0] as object), ...patch }] }] });
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
  assert.match(load({ clients: [base.clients[0], { ...base.clients[1], client_id: "laptop" }] }), /duplicate client_id/);
  assert.match(load({ clients: [client("c", MARKER_A, [project("p", "/a"), project("p", "/b")])] }), /duplicate project_id within a client/);
});

test("an enabled Client needs a credential digest; a disabled one may keep or lack it", () => {
  assert.match(load({ clients: [client("c", null, [])] }), /needs a credential digest/);
  assert.equal(load({ clients: [client("c", null, [], { enabled: false })] }), "");
  assert.equal(load({ clients: [client("c", MARKER_A, [], { enabled: false })] }), "");
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
  writeFileSync(file, JSON.stringify({ clients: [client("laptop", MARKER_A, [project("web", "/srv/web"), project("web", "/dup")])] }));
  assert.throws(() => store.reload(), ConfigError);
  assert.equal(JSON.stringify(store.snapshot()), before, "the last good snapshot is untouched");
  assert.equal(JSON.stringify(store.effectivePoliciesFor("laptop")), policiesBefore);
  assert.match(readFileSync(file, "utf8"), /web.*dup/s, "the file is never rewritten or repaired");
  writeFileSync(file, JSON.stringify({ clients: [client("laptop", MARKER_A, [project("only", "/srv/only")])] }));
  store.reload();
  assert.deepEqual(store.snapshot().clients.map((c) => c.client_id), ["laptop"], "desktop was removed");
  assert.deepEqual(store.effectivePoliciesFor("laptop")?.map((p) => p.project_id), ["only"]);
  assert.equal(store.effectivePoliciesFor("desktop"), null);
});

test("effective policies are shared-valid, carry only operational fields, and exist only for an enabled registered Client", () => {
  const store = new ServerConfigStore(write({ clients: [...valid().clients, client("off", MARKER_A, [project("p", "/x")], { enabled: false })] }));
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
  writeFileSync(file, JSON.stringify({ clients: [client("c", MARKER_A, [], { credential_sha256: hashCredential(MARKER_A).toUpperCase() })] }));
  const message = problems(() => store.reload());
  assert.ok(message && !message.includes(hashCredential(MARKER_A)) && !message.includes(MARKER_A), "errors never echo values");
});

test("the server package holds no network, session, watcher, database or UI code", () => {
  const src = path.join(import.meta.dirname, "..", "src");
  const text = readdirSync(src).map((f) => readFileSync(path.join(src, f), "utf8")).join("\n");
  assert.ok(!/node:(net|http|https|tls|dgram|child_process)\b|\bws\b|fs\.watch|\bwatch\(|sqlite|yaml/i.test(text));
  assert.ok(!/\/reach\/|reach-private/.test(text), "no hardcoded private path");
});
