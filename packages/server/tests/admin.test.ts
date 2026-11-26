import { RUNTIME_DEFAULTS } from "@reach-mcp/shared/runtime-settings";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { newIdentity } from "./identity-fixture.ts";
import { renderAdminPage } from "../src/admin-page.ts";
import { ClientConnectionRegistry, createAdminHandler, createHttpServer, hashCredential, ProposalStore, ServerConfigStore } from "../src/index.ts";

const MCP_BEARER = "mcp-bearer-" + "Vt29Qw71";
const PRIVATE_ROOT = "/srv/admin-private-root";

async function start(initialConfig = false) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "reach-admin-")), "config.json");
  const config = new ServerConfigStore(file);
  const connections = new ClientConnectionRegistry({ config, serverBuild: "srv-a", isBuildCompatible: () => true });
  let syncs = 0;
  const realSync = connections.syncAllPolicies.bind(connections);
  connections.syncAllPolicies = () => (syncs++, realSync());
  const proposals = new ProposalStore({ path: path.join(path.dirname(file), "proposal.json"), config, connections });
  const server = createServer(createAdminHandler({ config, connections, proposals, serverBuild: "srv-a", uptimeSeconds: () => 5 }));
  const service = createHttpServer({ config, connections, proposals, serverBuild: "srv-a" });
  await Promise.all([server, service].map((s) => new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()))));
  const a = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const d = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
  const put = (body: unknown) => fetch(`${a}/admin/api/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (initialConfig) await put({ mcp_bearer: MCP_BEARER, clients: [{ client_id: "laptop", enabled: false, projects: [{ project_id: "web", physical_root: PRIVATE_ROOT, mode: "read_only" }] }] });
  const close = async () => {
    connections.stop();
    for (const s of [server, service]) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  };
  return { a, d, file, config, connections, proposals, put, close, syncs: () => syncs };
}

test("setup mode: the admin surface works while the data plane stays closed, then the first config opens it", async () => {
  const rt = await start();
  const state = (await (await fetch(`${rt.a}/admin/api/state`)).json()) as { setup_mode: boolean; health: { config_active: boolean } };
  assert.equal(state.setup_mode, true);
  assert.equal(state.health.config_active, false);
  assert.equal((await fetch(`${rt.d}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${MCP_BEARER}` } })).status, 503);
  const res = await rt.put({ mcp_bearer: MCP_BEARER, clients: [] });
  assert.equal(res.status, 200);
  assert.equal(((await (await fetch(`${rt.a}/admin/api/state`)).json()) as { setup_mode: boolean }).setup_mode, false);
  assert.equal((await fetch(`${rt.d}/health`, { headers: { Authorization: `Bearer ${MCP_BEARER}` } })).status, 200, "the new bearer authenticates the data plane");
  await rt.close();
});

test("autosave: a valid edit persists and syncs policies once, an invalid one changes nothing and does not sync", async () => {
  const rt = await start(true);
  const afterSetup = rt.syncs();
  const before = readFileSync(rt.file, "utf8");
  const edit = { clients: [{ client_id: "laptop", display_name: "Laptop", enabled: false, projects: [{ project_id: "web", physical_root: PRIVATE_ROOT, mode: "read_write" }] }] };
  const ok = await rt.put(edit);
  assert.equal(ok.status, 200);
  assert.equal(rt.syncs(), afterSetup + 1);
  assert.equal(rt.config.snapshot().clients[0]?.projects[0]?.mode, "read_write");
  const saved = readFileSync(rt.file, "utf8");
  assert.notEqual(saved, before);
  const secret = "too short";
  const bad = await rt.put({ mcp_bearer: secret, clients: [{ client_id: "laptop", enabled: true, projects: [] }] });
  assert.equal(bad.status, 422);
  const body = (await bad.json()) as { ok: boolean };
  assert.equal(body.ok, false);
  assert.ok(!JSON.stringify(body).includes(secret), "a submitted secret is not echoed");
  assert.equal(readFileSync(rt.file, "utf8"), saved, "the file is unchanged");
  assert.equal(rt.config.snapshot().clients[0]?.projects[0]?.mode, "read_write", "the active snapshot is unchanged");
  assert.equal(rt.syncs(), afterSetup + 1, "no sync after a refusal");
  assert.equal((await fetch(`${rt.a}/admin/api/config`, { method: "PUT", body: "{not json" })).status, 400);
  await rt.close();
});

test("no response carries a key, digest or bearer; there is no credential route; an enrolled Client keeps its key through admin edits", async () => {
  const rt = await start(true);
  await rt.put({ clients: [{ client_id: "laptop", enabled: true, projects: [] }] }).then((r) => assert.equal(r.status, 422, "enabled without an enrolled key is refused"));
  assert.equal((await fetch(`${rt.a}/admin/api/clients/laptop/credential`, { method: "POST" })).status, 404, "the shared-credential route is gone");
  const identity = newIdentity();
  rt.config.registerPendingClient("box", identity.publicKey);
  assert.equal(rt.config.admissionOf("box")?.publicKey, identity.publicKey);
  assert.equal((await rt.put({ clients: [{ client_id: "laptop", enabled: false, projects: [] }, { client_id: "box", enabled: true, projects: [] }] })).status, 200, "the stored key was kept");
  assert.equal(rt.config.admissionOf("box")?.publicKey, identity.publicKey);
  for (const p of ["/admin/api/config", "/admin/api/state", "/admin"]) {
    const text = await (await fetch(`${rt.a}${p}`)).text();
    for (const leaked of [identity.publicKey, identity.privateKey, MCP_BEARER, hashCredential(MCP_BEARER), "sha256"]) assert.ok(!text.includes(leaked), `${p} leaked a secret`);
  }
  assert.equal(readFileSync(rt.file, "utf8").includes(identity.privateKey), false);
  await rt.close();
});

test("two listeners: admin paths only under / and /admin on the admin port; the service port serves only its own families and 404s the admin paths", async () => {
  const rt = await start(true);
  for (const p of ["/admin-x", "/administrator", "/mcp/admin", "/client", "/mcp", "/health"]) assert.equal((await fetch(`${rt.a}${p}`)).status, 404, `admin port ${p}`);
  for (const p of ["/", "/admin", "/admin/api/state", "/admin/api/config", "/admin/api/proposal"]) assert.equal((await fetch(`${rt.d}${p}`)).status, 404, `service port ${p}`);
  assert.equal((await fetch(`${rt.d}/mcp`, { method: "POST" })).status, 401, "the MCP route still needs its bearer");
  assert.equal((await fetch(`${rt.d}/health`, { headers: { Authorization: `Bearer ${MCP_BEARER}` } })).status, 200);
  assert.equal((await fetch(`${rt.a}/admin/api/state`, { method: "POST" })).status, 405);
  await rt.close();
});

test("admin proposal endpoints: diff, approve once, stale conflict, reject, unknown id", async () => {
  const rt = await start(true);
  const body = (path: string, method = "GET") => fetch(`${rt.a}${path}`, { method }).then(async (r) => ({ status: r.status, json: JSON.parse((await r.text()) || "{}") as Record<string, unknown> }));
  const edit = (mode: string) => ({ clients: [{ client_id: "laptop", enabled: false, projects: [{ project_id: "web", physical_root: PRIVATE_ROOT, mode }] }] });
  assert.deepEqual((await body("/admin/api/proposal")).json, { proposal: null, unusable: false });
  const first = rt.proposals.propose(edit("read_write")) as { proposal_id: string };
  const shown = (await body("/admin/api/proposal")).json.proposal as { proposal_id: string; diff: { path: string }[] };
  assert.equal(shown.proposal_id, first.proposal_id);
  assert.deepEqual(shown.diff.map((d) => d.path), ["clients[laptop].projects[web].mode"]);
  const before = rt.syncs();
  assert.equal((await body(`/admin/api/proposal/${first.proposal_id}/approve`, "POST")).status, 200);
  assert.equal(rt.syncs(), before + 1, "exactly one sync for an approval");
  assert.equal(rt.config.snapshot().clients[0]?.projects[0]?.mode, "read_write");
  const second = rt.proposals.propose(edit("read_only")) as { proposal_id: string };
  assert.equal((await rt.put(edit("read_write"))).status, 200);
  rt.config.applyEdit({ clients: [{ client_id: "laptop", display_name: "changed", enabled: false, projects: [{ project_id: "web", physical_root: PRIVATE_ROOT, mode: "read_write" }] }] });
  const stale = await body(`/admin/api/proposal/${second.proposal_id}/approve`, "POST");
  assert.equal(stale.status, 409);
  assert.equal(rt.syncs(), before + 1 + 1, "only the PUT synced; the stale approval did not");
  assert.equal((await body(`/admin/api/proposal/${second.proposal_id}/reject`, "POST")).status, 200);
  assert.equal((await body("/admin/api/proposal/nope/reject", "POST")).status, 404);
  assert.equal((await body(`/admin/api/proposal/${second.proposal_id}/approve`)).status, 405);
  await rt.close();
});

test("admin autosave changes the log size and retention through the config owner; bad values change nothing", async () => {
  const rt = await start(true);
  const clients = rt.config.editableView().clients.map(({ client_id, enabled, projects }) => ({ client_id, enabled, projects }));
  assert.equal((await rt.put({ logging: { max_bytes: 8192, retention_days: 3 }, clients })).status, 200);
  const view = (await (await fetch(`${rt.a}/admin/api/config`)).json()) as { logging: unknown };
  assert.deepEqual(view.logging, { max_bytes: 8192, retention_days: 3, level: "RUNNING" });
  assert.equal((await rt.put({ logging: { max_bytes: 1, retention_days: 3 }, clients })).status, 422);
  assert.deepEqual(rt.config.loggingSettings(), { max_bytes: 8192, retention_days: 3, level: "RUNNING" });
  await rt.close();
});

test("the page is vanilla: no framework or remote script, no generic Save button; the Clients screen calls only the lifecycle API", async () => {
  const rt = await start();
  const html = await (await fetch(`${rt.a}/admin`)).text();
  assert.ok(!/>\s*Save\s*</i.test(html), "no generic Save button");
  assert.ok(!/<script[^>]*\ssrc=|react|vue|svelte|angular|jquery/i.test(html));
  assert.ok(html.includes("/admin/api/clients") && html.includes("/rotate-key") && html.includes('"/enable"') && html.includes('"/disable"'), "the Clients screen drives the lifecycle API");
  assert.ok(html.includes("/admin/api/proposal") && !html.includes("mcp_bearer_sha256"), "the proposal review is a card of the Projects screen and calls only the proposal API");
  assert.equal((await fetch(`${rt.a}/`, { redirect: "manual" })).status, 302);
  await rt.close();
});

test("static owner audit: admin holds no schema, store, session or health calculation of its own", () => {
  const src = path.join(import.meta.dirname, "..", "src");
  const admin = readFileSync(path.join(src, "admin.ts"), "utf8");
  assert.ok(!/from "zod"|writeFileSync|renameSync|readFileSync|new Map|new Set|node:crypto|ws"/.test(admin));
  assert.ok(/buildHealth/.test(admin) && /syncAllPolicies/.test(admin));
  const dataPlane = readFileSync(path.join(src, "http-server.ts"), "utf8");
  assert.ok(!/node:fs|syncAllPolicies|ServerConfigStore\(/.test(dataPlane), "the listener only mounts the admin owner, it owns none of it");
});

test("Clients API: one safe list with counts that add up; Enable and Disable persist through the config owner; Rotate Key refuses what is not an online Enabled Client; nothing leaks a key", async () => {
  const rt = await start(true);
  const identity = newIdentity();
  rt.config.registerPendingClient("box", identity.publicKey, "Friendly box");
  const list = async () => (await (await fetch(`${rt.a}/admin/api/clients`)).json()) as { clients: { client_id: string; display_name?: string; status: string; online: boolean; fingerprint: string | null; last_seen: number | null }[]; counts: Record<string, number> };
  let view = await list();
  assert.deepEqual(view.counts, { total: 2, enabled: 0, pending: 1, disabled: 1, online: 0, incompatible: 0, offline: 2 });
  assert.equal(view.counts.pending! + view.counts.enabled! + view.counts.disabled!, view.counts.total, "the statuses always add up");
  const box = view.clients.find((c) => c.client_id === "box")!;
  assert.deepEqual([box.display_name, box.status, box.online], ["Friendly box", "pending", false]);
  assert.match(box.fingerprint!, /^ed25519:[0-9a-f]{64}$/);
  const refusalOf = async () => ((await (await fetch(`${rt.a}/admin/api/clients`)).json()) as { clients: { client_id: string; policy_refusal: unknown }[] }).clients.find((c) => c.client_id === "box")!.policy_refusal;
  assert.equal(await refusalOf(), null);
  const standing = { reason: "OUTSIDE_ROOT" as const, project_id: "web", refused_at: 7, occurrences: 2 };
  const registry = rt.connections.policyRefusal.bind(rt.connections);
  rt.connections.policyRefusal = (id) => (id === "box" ? standing : registry(id));
  assert.deepEqual(await refusalOf(), standing, "an offline Client still shows why it was refused");
  rt.connections.policyRefusal = registry;
  assert.equal(await refusalOf(), null);
  const text = JSON.stringify(view);
  assert.ok(!text.includes(identity.publicKey) && !text.includes(identity.privateKey), "the list carries a fingerprint, never a key");

  const post = (id: string, action: string) => fetch(`${rt.a}/admin/api/clients/${encodeURIComponent(id)}/${action}`, { method: "POST" });
  const before = rt.syncs();
  assert.equal((await post("box", "enable")).status, 200);
  assert.equal(rt.config.admissionOf("box")?.status, "enabled");
  assert.equal(rt.syncs(), before + 1, "policies are pushed once");
  assert.equal((await post("box", "disable")).status, 200);
  assert.deepEqual([rt.config.admissionOf("box")?.status, rt.config.admissionOf("box")?.publicKey], ["disabled", identity.publicKey], "Disable keeps the identity");
  assert.ok(readFileSync(rt.file, "utf8").includes('"enabled": false'), "persisted by the config owner");
  assert.equal((await post("ghost", "enable")).status, 422, "an unknown client is refused deterministically");
  assert.equal((await fetch(`${rt.a}/admin/api/clients/%E0%A4%A/enable`, { method: "POST" })).status, 400, "a malformed id is a bad request");
  assert.equal((await post("box", "rotate-key")).status, 409, "a Client that is not connected cannot rotate");
  const update = await post("box", "update");
  assert.deepEqual([update.status, (await update.json()) as object], [409, { ok: false, result: "offline" }], "an offline Client cannot be asked to update: nothing is queued");
  assert.equal((await fetch(`${rt.a}/admin/api/clients/box/update`)).status, 405, "update is an explicit POST");
  assert.equal((await post("box", "purge")).status, 404, "only the lifecycle actions exist");
  assert.equal((await fetch(`${rt.a}/admin/api/clients/box/enable`)).status, 405);
  assert.equal((await fetch(`${rt.a}/admin/api/clients`, { method: "POST" })).status, 405);
  view = await list();
  assert.equal(view.clients.find((c) => c.client_id === "box")?.status, "disabled");
  await rt.close();
});

test("the operator label comes from one value: the product default, or the configured name, escaped as data", async () => {
  const rt = await start();
  const html = await (await fetch(`${rt.a}/admin`)).text();
  assert.match(html, /const ADMIN_USER = "admin";/);
  assert.equal(renderAdminPage({ adminUser: "Anusauipenau" }).includes('const ADMIN_USER = "Anusauipenau";'), true);
  const hostile = renderAdminPage({ adminUser: '</script><b>"x' });
  assert.ok(!hostile.includes("</script><b>") && hostile.includes("\\u003c/script>"), "a hostile name cannot leave the data string");
  await rt.close();
});

test("Client display name API: PUT renames through the audited change path; wrong method, malformed or extra fields, bad length and unknown client are refused and change nothing", async () => {
  const rt = await start(true);
  rt.config.registerPendingClient("box", newIdentity().publicKey);
  const url = `${rt.a}/admin/api/clients/box/display-name`;
  const put = (body: unknown, target = url) => fetch(target, { method: "PUT", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const name = () => rt.config.clientSummaries().find((c) => c.client_id === "box")?.display_name;
  const before = rt.syncs();
  const ok = await put({ display_name: "  Studio  " });
  assert.equal(ok.status, 200);
  assert.equal(name(), "Studio");
  assert.equal(rt.syncs(), before + 1, "policies are synced once through the one change path");
  assert.equal(rt.config.admissionOf("box")?.status, "pending", "rename does not change the status");
  assert.equal((await put({ display_name: "Studio" })).status, 200, "the same rename again is idempotent");
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
  assert.equal((await fetch(url, { method: "GET" })).status, 405);
  assert.equal((await put({ display_name: "A", enabled: true })).status, 400, "extra field");
  assert.equal((await put({ name: "A" })).status, 400, "wrong field");
  assert.equal((await put({ display_name: 5 })).status, 400, "wrong type");
  assert.equal((await put("not json")).status, 400);
  assert.equal((await put({ display_name: "   " })).status, 422, "blank");
  assert.equal((await put({ display_name: "q".repeat(101) })).status, 422, "over 100");
  assert.equal((await put({ display_name: "A" }, `${rt.a}/admin/api/clients/nobody/display-name`)).status, 422, "unknown client");
  assert.equal((await put({ display_name: "q".repeat(100) })).status, 200, "100 is valid");
  await put({ display_name: "Final" });
  assert.equal(name(), "Final");
  await rt.close();
});

test("Client Auto Update API: PUT changes only that Client's policy through the audited change path, persists, is listed, and every refusal changes and syncs nothing", async () => {
  const rt = await start(true);
  rt.config.registerPendingClient("box", newIdentity().publicKey);
  const url = `${rt.a}/admin/api/clients/box/auto-update`;
  const put = (body: unknown, target = url) => fetch(target, { method: "PUT", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const listed = async () => ((await (await fetch(`${rt.a}/admin/api/clients`)).json()) as { clients: { client_id: string; auto_update: boolean }[] }).clients.find((c) => c.client_id === "box")?.auto_update;
  const others = () => JSON.stringify({ ...rt.config.snapshot().clients.find((c) => c.client_id === "box"), auto_update: null });
  assert.equal(await listed(), false, "default OFF");
  const kept = others();
  const before = rt.syncs();
  assert.equal((await put({ auto_update: true })).status, 200);
  assert.equal(await listed(), true);
  assert.equal(rt.syncs(), before + 1, "policies are synced once through the one change path");
  assert.equal(others(), kept, "no other field of the Client changed");
  assert.equal((JSON.parse(readFileSync(rt.file, "utf8")).clients as { client_id: string; auto_update: boolean }[]).find((c) => c.client_id === "box")?.auto_update, true, "persisted on disk");
  assert.equal((await put({ auto_update: false })).status, 200);
  assert.equal(await listed(), false);
  const after = rt.syncs();
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
  assert.equal((await fetch(url, { method: "GET" })).status, 405);
  assert.equal((await put({ auto_update: true, enabled: true })).status, 400, "extra field");
  assert.equal((await put({ enabled: true })).status, 400, "wrong field");
  assert.equal((await put({ auto_update: "yes" })).status, 400, "wrong type");
  assert.equal((await put("not json")).status, 400);
  assert.equal((await put({ auto_update: true }, `${rt.a}/admin/api/clients/nobody/auto-update`)).status, 422, "unknown client");
  assert.equal(await listed(), false, "refusals changed nothing");
  assert.equal(rt.syncs(), after, "no refusal pushed policies");
  await rt.close();
});

test("runtime knobs over the Admin API: the state serves the autosave debounce, a PUT with a runtime section persists and applies it live, and an edit without one keeps it", async () => {
  const rt = await start(true);
  const debounce = async () => ((await (await fetch(`${rt.a}/admin/api/state`)).json()) as { runtime: { admin_autosave_debounce_ms: number } }).runtime.admin_autosave_debounce_ms;
  assert.equal(await debounce(), RUNTIME_DEFAULTS.admin_autosave_debounce_ms, "the canonical default before any override");
  const clients = [{ client_id: "laptop", enabled: false, projects: [{ project_id: "web", physical_root: PRIVATE_ROOT, mode: "read_only" }] }];
  const syncs = rt.syncs();
  assert.equal((await rt.put({ runtime: { ...RUNTIME_DEFAULTS, admin_autosave_debounce_ms: 900 }, clients })).status, 200);
  assert.equal(await debounce(), 900, "applied live, no restart");
  assert.equal(rt.syncs(), syncs + 1, "Clients are re-synced so they receive the live timing");
  assert.equal((await rt.put({ clients })).status, 200);
  assert.equal(await debounce(), 900, "an autosave edit without a runtime section keeps the override");
  const bad = await rt.put({ runtime: { ...RUNTIME_DEFAULTS, admin_autosave_debounce_ms: 1 }, clients });
  assert.equal(bad.status, 422);
  assert.equal(await debounce(), 900, "an invalid value changes nothing");
  const view = (await (await fetch(`${rt.a}/admin/api/config`)).json()) as { runtime: { admin_autosave_debounce_ms: number } };
  assert.equal(view.runtime.admin_autosave_debounce_ms, 900);
  assert.equal(readFileSync(rt.file, "utf8").includes('"admin_autosave_debounce_ms": 900'), true, "persisted in the one config file");
  await rt.close();
});

test("admin proposal item endpoints: review one rule at a time, approve-all as a convenience, MCP has no approval path", async () => {
  const rt = await start(true);
  const body = (path: string, method = "GET") => fetch(`${rt.a}${path}`, { method }).then(async (r) => ({ status: r.status, json: JSON.parse((await r.text()) || "{}") as Record<string, unknown> }));
  const edit = { clients: [{ client_id: "laptop", enabled: false, projects: [{ project_id: "web", physical_root: PRIVATE_ROOT, mode: "read_only", deny_globs: ["a/**", "b/**", "c/**"] }] }] };
  const made = rt.proposals.propose(edit) as { proposal_id: string };
  const shown = (await body("/admin/api/proposal")).json.proposal as { items: { item_id: string; path: string; status: string }[] };
  assert.equal(shown.items.length, 3);
  const [a, b] = shown.items;
  const before = rt.syncs();
  const rejected = await body(`/admin/api/proposal/${made.proposal_id}/items/${a!.item_id}/reject`, "POST");
  assert.deepEqual([rejected.status, rejected.json.remaining], [200, 2]);
  assert.equal(rt.syncs(), before, "rejecting syncs nothing");
  const approved = await body(`/admin/api/proposal/${made.proposal_id}/items/${b!.item_id}/approve`, "POST");
  assert.deepEqual([approved.status, approved.json.remaining], [200, 1]);
  assert.equal(rt.syncs(), before + 1);
  assert.equal((await body(`/admin/api/proposal/${made.proposal_id}/items/${a!.item_id}/approve`, "POST")).status, 404, "a decided item is gone");
  assert.equal((await body(`/admin/api/proposal/${made.proposal_id}/items/${b!.item_id}/approve`)).status, 405);
  assert.equal((await body(`/admin/api/proposal/${made.proposal_id}/approve`, "POST")).status, 200, "approve-all takes what is still pending");
  assert.deepEqual((rt.config.snapshot().clients[0]?.projects[0] as { deny_globs?: string[] }).deny_globs?.slice().sort(), ["b/**", "c/**"], "the rejected rule never applied");
  assert.equal((await body("/admin/api/proposal")).json.proposal, null);
  await rt.close();
});

test("retire: removes exactly one Client by id, forgets its runtime facts, audits without keys, and the identity can only return as Pending", async () => {
  const rt = await start(true);
  const identity = newIdentity();
  rt.config.registerPendingClient("box", identity.publicKey);
  rt.config.setClientEnabled("box", true);
  const forgotten: string[] = [];
  const forget = rt.connections.forget.bind(rt.connections);
  rt.connections.forget = (id) => (forgotten.push(id), forget(id));
  const post = (id: string, action = "retire") => fetch(`${rt.a}/admin/api/clients/${id}/${action}`, { method: "POST" });
  const laptop = () => rt.config.editableView().clients.find((c) => c.client_id === "laptop");
  const untouched = laptop();
  assert.equal((await post("box", "disable")).status, 200);
  assert.equal(rt.config.admissionOf("box")?.status, "disabled", "Disable keeps the record");
  const before = readFileSync(rt.file, "utf8");
  assert.equal((await post("nobody")).status, 422);
  assert.equal(readFileSync(rt.file, "utf8"), before, "an unknown id changes nothing");
  assert.equal((await fetch(`${rt.a}/admin/api/clients/box/retire`)).status, 405);
  const res = await post("box");
  assert.equal(res.status, 200);
  assert.ok(!(await res.text()).includes(identity.publicKey));
  assert.equal(rt.config.admissionOf("box"), null);
  assert.deepEqual(laptop(), untouched);
  assert.deepEqual(forgotten, ["box"], "only the retired Client's session is touched");
  assert.ok(!readFileSync(rt.file, "utf8").includes(identity.publicKey), "no tombstone");
  assert.equal((await post("box")).status, 422, "already retired");
  await rt.close();
});
