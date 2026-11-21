import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { newIdentity } from "./identity-fixture.ts";
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
  return { a, d, file, config, proposals, put, close, syncs: () => syncs };
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
  rt.config.enrollClient("box", identity.publicKey);
  assert.equal(rt.config.publicKeyFor("box"), identity.publicKey);
  assert.equal((await rt.put({ clients: [{ client_id: "laptop", enabled: false, projects: [] }, { client_id: "box", enabled: true, projects: [] }] })).status, 200, "the stored key was kept");
  assert.equal(rt.config.publicKeyFor("box"), identity.publicKey);
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
  assert.deepEqual((await body("/admin/api/proposal")).json, { proposal: null });
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
  assert.deepEqual(view.logging, { max_bytes: 8192, retention_days: 3 });
  assert.equal((await rt.put({ logging: { max_bytes: 1, retention_days: 3 }, clients })).status, 422);
  assert.deepEqual(rt.config.loggingSettings(), { max_bytes: 8192, retention_days: 3 });
  await rt.close();
});

test("the page is vanilla: debounced autosave, no Save button, no framework or remote script", async () => {
  const rt = await start();
  const html = await (await fetch(`${rt.a}/admin`)).text();
  assert.match(html, /DEBOUNCE_MS = \d+/);
  assert.match(html, /setTimeout\(save, DEBOUNCE_MS\)/);
  assert.ok(!/>\s*Save\s*</i.test(html), "no generic Save button");
  assert.ok(html.includes('id: "log-bytes"') && html.includes('id: "log-days"'), "log size and retention fields exist");
  assert.ok(html.includes('"Approve"') && html.includes('"Reject"') && html.includes("/admin/api/proposal"), "approve and reject exist for a pending proposal");
  assert.ok(!/<script[^>]*\ssrc=|react|vue|svelte|angular|jquery/i.test(html));
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
