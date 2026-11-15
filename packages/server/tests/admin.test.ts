import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClientConnectionRegistry, createAdminServer, createHttpServer, hashCredential, ServerConfigStore } from "../src/index.ts";

const MCP_BEARER = "mcp-bearer-" + "Vt29Qw71";
const PRIVATE_ROOT = "/srv/admin-private-root";

async function start(initialConfig = false) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "reach-admin-")), "config.json");
  const config = new ServerConfigStore(file);
  const connections = new ClientConnectionRegistry({ config, serverBuild: "srv-a", isBuildCompatible: () => true });
  let syncs = 0;
  const realSync = connections.syncAllPolicies.bind(connections);
  connections.syncAllPolicies = () => (syncs++, realSync());
  const admin = createAdminServer({ config, connections, serverBuild: "srv-a", uptimeSeconds: () => 5 });
  const data = createHttpServer({ config, connections, serverBuild: "srv-a" });
  for (const s of [admin, data]) await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const url = (s: typeof admin) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const a = url(admin);
  const d = url(data);
  const put = (body: unknown) => fetch(`${a}/admin/api/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (initialConfig) await put({ mcp_bearer: MCP_BEARER, clients: [{ client_id: "laptop", enabled: false, projects: [{ project_id: "web", physical_root: PRIVATE_ROOT, mode: "read_only" }] }] });
  const close = async () => {
    connections.stop();
    for (const s of [admin, data]) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  };
  return { a, d, file, config, put, close, syncs: () => syncs };
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

test("no response carries a digest, a bearer or a credential; a generated credential is shown once", async () => {
  const rt = await start(true);
  await rt.put({ clients: [{ client_id: "laptop", enabled: true, projects: [] }] }).then((r) => assert.equal(r.status, 422, "enabled without a credential is refused"));
  const issued = await fetch(`${rt.a}/admin/api/clients/laptop/credential`, { method: "POST" });
  assert.equal(issued.status, 200);
  const credential = ((await issued.json()) as { result: { credential: string } }).result.credential;
  assert.ok(credential.length >= 40);
  assert.equal(rt.config.credentialDigestFor("laptop"), null, "still disabled, so no admission digest");
  assert.equal((await rt.put({ clients: [{ client_id: "laptop", enabled: true, projects: [] }] })).status, 200, "now enabled, the stored digest was kept");
  assert.equal(rt.config.credentialDigestFor("laptop"), hashCredential(credential));
  for (const p of ["/admin/api/config", "/admin/api/state", "/admin"]) {
    const text = await (await fetch(`${rt.a}${p}`)).text();
    for (const leaked of [credential, MCP_BEARER, hashCredential(credential), hashCredential(MCP_BEARER), "sha256"]) assert.ok(!text.includes(leaked), `${p} leaked a secret`);
  }
  assert.equal((await fetch(`${rt.a}/admin/api/clients/nobody/credential`, { method: "POST" })).status, 422);
  assert.equal(readFileSync(rt.file, "utf8").includes(credential), false);
  await rt.close();
});

test("the admin surface is its own listener: the data plane has no admin path and the admin has no data-plane path", async () => {
  const rt = await start(true);
  for (const p of ["/admin", "/admin/api/state", "/admin/api/config"]) assert.equal((await fetch(`${rt.d}${p}`, { headers: { Authorization: `Bearer ${MCP_BEARER}` } })).status, 404, p);
  for (const p of ["/mcp", "/health", "/client"]) assert.equal((await fetch(`${rt.a}${p}`)).status, 404, p);
  assert.equal((await fetch(`${rt.a}/admin/api/state`, { method: "POST" })).status, 405);
  await rt.close();
});

test("the page is vanilla: debounced autosave, no Save button, no framework or remote script", async () => {
  const rt = await start();
  const html = await (await fetch(`${rt.a}/admin`)).text();
  assert.match(html, /DEBOUNCE_MS = \d+/);
  assert.match(html, /setTimeout\(save, DEBOUNCE_MS\)/);
  assert.ok(!/>\s*Save\s*</i.test(html), "no generic Save button");
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
  assert.ok(!/["`]\/admin|createAdminServer/.test(dataPlane), "the data-plane listener serves no admin route");
});
