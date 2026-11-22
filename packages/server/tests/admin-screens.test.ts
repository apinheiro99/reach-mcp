// The four screens of Task 80 (Projects, System, API, Logs): the Server read models behind them and the structure of each view.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { endpointCatalog } from "../src/endpoint-catalog.ts";
import { ClientConnectionRegistry, createAdminHandler, ProposalStore, ServerConfigStore } from "../src/index.ts";
import { newIdentity } from "./identity-fixture.ts";
import { ACCESS_RULES_JS } from "../src/admin-ui/projects.ts";

const UI_DIR = path.join(import.meta.dirname, "..", "src", "admin-ui");
const ui = (name: string) => readFileSync(path.join(UI_DIR, name), "utf8");
const BEARER = "mcp-bearer-" + "Vt29Qw71";

async function start(options: { artifacts?: boolean } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), "reach-screens-"));
  const logs = path.join(base, "logs");
  const file = path.join(base, "config.json");
  const config = new ServerConfigStore(file);
  const connections = new ClientConnectionRegistry({ config, serverBuild: "v2026.11.000042", isBuildCompatible: () => true });
  const proposals = new ProposalStore({ path: path.join(base, "proposal.json"), config, connections });
  const server = createServer(createAdminHandler({ config, connections, proposals, serverBuild: "v2026.11.000042", repositoryCommit: "abcdef1234567890", uptimeSeconds: () => 90, logsDir: logs, ...(options.artifacts ? { artifactsDir: base } : {}) }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the tests read untyped JSON answers
  return { url, base, logs, config, get: async (p: string) => (await fetch(`${url}${p}`)).json() as Promise<any>, close: () => { server.closeAllConnections(); connections.stop(); return new Promise<void>((r) => server.close(() => r())); } };
}

test("Projects: the config view carries policies and status facts but never a key, and an edit autosaves through the one owner", async () => {
  const rt = await start();
  const key = newIdentity();
  const put = (body: unknown) => fetch(`${rt.url}/admin/api/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await put({ mcp_bearer: BEARER, clients: [{ client_id: "laptop", enabled: false, projects: [{ project_id: "web", physical_root: "/srv/web", mode: "read_only" }] }] })).status, 200);
  rt.config.registerPendingClient("newbox", key.publicKey);
  const view = JSON.stringify(await rt.get("/admin/api/config"));
  assert.ok(!view.includes(key.publicKey) && !view.includes(BEARER), "no key or bearer in the Projects data");
  assert.ok(view.includes('"pending":true'), "a pending Client reads as pending");
  const edit = await put({ clients: [{ client_id: "laptop", enabled: false, projects: [{ project_id: "web", physical_root: "/srv/web2", mode: "read_write" }] }, { client_id: "newbox", enabled: false, projects: [] }] });
  assert.equal(edit.status, 200);
  assert.equal(rt.config.snapshot().clients[0]?.projects[0]?.physical_root, "/srv/web2");
  assert.equal(rt.config.admissionOf("newbox")?.status, "pending", "an edit never promotes a pending Client");
  assert.equal((await put({ clients: [{ client_id: "laptop", enabled: false, projects: [{ project_id: "web", physical_root: "relative", mode: "read_only" }] }, { client_id: "newbox", enabled: false, projects: [] }] })).status, 422, "the Server refuses an invalid root");
  assert.equal(rt.config.snapshot().clients[0]?.projects[0]?.physical_root, "/srv/web2", "and keeps the last good value");
  await rt.close();
});

test("System: only facts the Server knows; storage is the configured directories; nothing is invented", async () => {
  const rt = await start({ artifacts: true });
  const system = await rt.get("/admin/api/system");
  assert.deepEqual(system.server, { build: "v2026.11.000042", commit: "abcdef1234567890", uptime_seconds: 90, config_active: false });
  assert.deepEqual(system.storage.map((s: { name: string }) => s.name), ["Release artifacts"], "a directory that does not exist is not reported (logs are created on first write)");
  assert.ok(system.storage[0].total_bytes > 0 && system.storage[0].free_bytes <= system.storage[0].total_bytes);
  assert.ok(!("tunnel" in system) && !("update" in system), "no tunnel or update telemetry is fabricated");
  assert.deepEqual(Object.keys(system.environment).sort(), ["cpus", "memory_bytes", "node", "platform"]);
  assert.equal((await fetch(`${rt.url}/admin/api/system`, { method: "POST" })).status, 405);
  await rt.close();
});

test("API: the catalog lists only implemented routes; status comes from owner facts, never from calling the routes", async () => {
  const active = endpointCatalog({ configActive: true, artifactsConfigured: true, installers: { sh: true, ps1: true } });
  assert.deepEqual(active.map((e) => `${e.method} ${e.path}`), ["GET /", "GET /install.sh", "GET /install.ps1", "GET /health", "POST /mcp", "GET /release/manifest", "GET /release/artifacts/:name", "WS /client"]);
  assert.deepEqual(new Set(active.map((e) => e.status)), new Set(["healthy"]));
  assert.deepEqual(endpointCatalog({ configActive: false, artifactsConfigured: false, installers: { sh: false, ps1: false } }).map((e) => e.status), ["healthy", "not_configured", "not_configured", "unavailable", "unavailable", "not_configured", "not_configured", "unavailable"]);
  const rt = await start();
  const api = await rt.get("/admin/api/endpoints");
  assert.deepEqual(api.counts, { http: 7, websocket: 1, healthy: 1, errors: 3, connected_clients: 0 });
  assert.deepEqual(Object.keys(api.requests).sort(), ["completed", "failed", "in_flight", "timed_out"], "only the counters the Server really keeps");
  await rt.close();
});

test("Logs: the endpoint returns the bounded normalized events of the existing files, and nothing when there are none", async () => {
  const rt = await start();
  assert.deepEqual(await rt.get("/admin/api/logs"), { events: [], truncated: false });
  const { mkdirSync } = await import("node:fs");
  mkdirSync(rt.logs, { recursive: true });
  writeFileSync(path.join(rt.logs, "reach.log"), "2026-11-20T10:00:00Z INFO runtime server started build=x\n");
  writeFileSync(path.join(rt.logs, "audit.log"), "2026-11-20T10:01:00Z\tactor=admin\taction=client_enable\tclient_id=laptop\tresult=ok\n");
  const logs = await rt.get("/admin/api/logs");
  assert.deepEqual(logs.events.map((e: { source: string; client: string | null }) => [e.source, e.client]), [["audit", "laptop"], ["server", null]]);
  await rt.close();
});

const stat = (src: string) => [...src.matchAll(/UI\.stat\(\{ icon: "[a-z-]+", value: [^,]+, label: "([^"]+)"/g)].map((m) => m[1]);

test("Projects view: six counters, one search, one Client filter, the six reference columns, boxed path control, autosave and no Save button", () => {
  const src = ui("projects.ts");
  assert.deepEqual(stat(src), ["Projects", "Mapped Clients", "Roots", "Read / Write", "Active", "Pending Review"]);
  assert.equal(src.match(/UI\.search\(/g)?.length, 1);
  assert.equal(src.match(/UI\.select\(\[\["all", "All clients"\]/g)?.length, 1, "one Client filter");
  assert.ok(src.includes('"Client", "Project", "Root Path", "Policy", "Access", "Actions"'));
  assert.ok(/className: "pj-root"/.test(src) && /UI\.icon\("folder"\)/.test(src) && /kind: "path"/.test(src), "the stronger boxed root-path treatment");
  assert.ok(/setTimeout\(save, 500\)/.test(src) && /api\("PUT", "\/admin\/api\/config"/.test(src), "~500 ms autosave through the config owner");
  assert.ok(!/Save["']|"Save/.test(src.replace(/Autosaved|Saving…|Not saved|Save changes/g, "")), "no Save button");
  assert.ok(!/rotate-key/.test(src), "no project-scoped rotation: Rotate Key stays on the Clients screen");
  assert.ok(!/public_key|has_public_key/.test(src), "the view never touches key material");
  assert.equal(src.match(/every\(load\)/g)?.length, 1);
});

test("System view: the reference regions, every value from /admin/api/system or an explicit not-exposed state", () => {
  const src = ui("system.ts");
  for (const title of ["REACH MCP Server", "Storage", "OpenAI Tunnel", "Runtime (Services)", "Automatic Update", "Environment"]) assert.ok(src.includes(title), title);
  assert.ok(/Not exposed by the Server/.test(src) && /managed by the deployment/.test(src), "tunnel and update say what they are");
  assert.ok(!/api\.openai\.com|\b42 ms\b|\bv26\.1\.3\b|reach-server|142\.6/.test(src), "no value of the mock is hardcoded");
  assert.ok(/api\("GET", "\/admin\/api\/system"\)/.test(src) && src.match(/every\(load\)/g)?.length === 1);
});

test("API view: six counters, the endpoint table, runtime metrics and notes; latency and rates are shown as not measured", () => {
  const src = ui("api.ts");
  assert.deepEqual(stat(src), ["HTTP Endpoints", "WebSocket", "Healthy", "Errors", "Avg Latency (not measured)", "Connected Clients"]);
  assert.ok(src.includes('"Method", "Path", "Purpose", "Status"') && /Integration Notes/.test(src) && /Runtime Metrics/.test(src));
  assert.ok(/Not measured/.test(src) && !/req\/s|\b38 ms\b|\b18 ms\b/.test(src), "no invented metric");
  assert.ok(/api\("GET", "\/admin\/api\/endpoints"\)/.test(src) && !/fetch\(/.test(src), "no route is polled from the page");
});

test("Logs view: six counters, one search, source and severity filters, an explicit Refresh and one poller", () => {
  const src = ui("logs.ts");
  assert.deepEqual(stat(src), ["Total Events", "Warnings", "Errors", "Client Events", "Server Events", "Audit Events"]);
  assert.equal(src.match(/UI\.search\(/g)?.length, 1);
  assert.equal(src.match(/UI\.select\(/g)?.length, 2, "source and severity");
  assert.ok(/UI\.button\("Refresh"/.test(src) && src.match(/every\(load\)/g)?.length === 1 && !/setInterval|setTimeout/.test(src));
  assert.ok(src.includes('"Time", "Source", "Severity", "Event", "Client", "Details"') && !/value: "tunnel"|"Tunnel/i.test(src), "no tunnel source");
  assert.ok(/api\("GET", "\/admin\/api\/logs"\)/.test(src));
});

test("all six screens are real: no placeholder remains, one poller owner, and the Overview contract names its real endpoints", () => {
  const page = readFileSync(path.join(UI_DIR, "..", "admin-page.ts"), "utf8");
  assert.ok(!/built in a later task/.test(page), "no placeholder screen is left");
  for (const view of ["overview", "clients", "projects", "system", "api", "logs"]) assert.ok(new RegExp(`VIEWS\\.${view} =`).test(page), view);
  for (const f of readdirSync(UI_DIR).filter((n) => n.endsWith(".ts") && n !== "shell.ts" && n !== "dev-reload.ts")) assert.ok(!/setInterval/.test(ui(f)), `${f} declares its own interval`);
  assert.ok(!/setInterval/.test(page), "the page composition declares no timer; the footer version rides the shell's one poller");
  assert.ok(/refreshVersion\(\); }, 5000\)/.test(ui("shell.ts")), "the footer version refreshes on the shell poller");
  assert.match(ui("overview.ts").split("\n").slice(0, 3).join(" "), /\/admin\/api\/state and \/admin\/api\/clients/);
});

const accessRules = new Function(`${ACCESS_RULES_JS}; return { rulesOf, policyOf };`)() as {
  rulesOf: (p: object) => { defaultMode: string; rules: { path: string; perm: string }[] };
  policyOf: (p: object, name: string, root: string, defaultMode: string, rules: { path: string; perm: string }[]) => object;
};
const policyBase = { project_id: "scope", physical_root: "/scope" };

test("access rules: read-only, full write and restricted write each map to one canonical policy and back without loss", () => {
  const { rulesOf, policyOf } = accessRules;
  assert.deepEqual(policyOf(policyBase, "scope", "/scope", "read_only", []), { ...policyBase, mode: "read_only" }, "read-only has no allowlist");
  assert.deepEqual(policyOf(policyBase, "scope", "/scope", "read_write", []), { ...policyBase, mode: "read_write" }, "full write has no writable_globs");
  const restricted = policyOf(policyBase, "scope", "/scope", "read_only", [{ path: "temp/**", perm: "write" }, { path: ".gitlab-ci.yml", perm: "write" }, { path: "*.key", perm: "deny" }]);
  assert.deepEqual(restricted, { ...policyBase, mode: "read_write", writable_globs: ["temp/**", ".gitlab-ci.yml"], deny_globs: ["*.key"] });
  assert.deepEqual(rulesOf(restricted), { defaultMode: "read_only", rules: [{ path: "temp/**", perm: "write" }, { path: ".gitlab-ci.yml", perm: "write" }, { path: "*.key", perm: "deny" }] });
  assert.equal(rulesOf({ ...policyBase, mode: "read_write" }).defaultMode, "read_write");
});

test("access rules: blank and duplicate paths are dropped, write rules are redundant under full write, and limits survive an edit", () => {
  const { policyOf } = accessRules;
  const withLimits = { ...policyBase, mode: "read_only", limits: { maxReadLines: 10 } };
  const out = policyOf(withLimits, " scope ", " /scope ", "read_write", [{ path: " ", perm: "deny" }, { path: "a/**", perm: "write" }, { path: "x", perm: "deny" }, { path: "x", perm: "deny" }]);
  assert.deepEqual(out, { ...policyBase, mode: "read_write", limits: { maxReadLines: 10 }, deny_globs: ["x"] });
});

test("Projects drawer: right-side panel with project configuration, access rules, explanation, Cancel and Save, and the row action is not a new-project plus", () => {
  const src = ui("projects.ts");
  const components = ui("components.ts");
  assert.ok(/UI\.drawer\(/.test(src) && /drawer\(\{ title, subtitle, children, footer, onClose \}\)/.test(components), "one drawer primitive in components.ts");
  for (const text of ["Project configuration", "Access rules", "How it works", "Add rule", "Cancel", "Save changes", "Edit access and permissions"]) assert.ok(src.includes(text), text);
  assert.ok(!/iconButton\("plus", "Add a project", \(\) => newProject\(c\)\), UI\.iconButton\("trash"/.test(src), "a project row has no plus that implies a new project");
  assert.ok(/for \(const k of \["writable_globs", "deny_globs"\]\) delete p\[k\]/.test(src), "saving replaces the canonical fields instead of merging stale ones");
});
