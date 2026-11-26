// Task #139: the Admin UI as a thin client of the Server: lossless allow rules, autosaving drawer, broad-root confirmation, granular
// proposal review, Client identity facts and runtime/logging controls. Pure browser functions are evaluated, views are checked as structure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClientConnectionRegistry, createAdminHandler, ProposalStore, ServerConfigStore } from "../src/index.ts";
import { ACCESS_RULES_JS } from "../src/admin-ui/projects.ts";
import { renderAdminPage } from "../src/admin-page.ts";
import { newIdentity } from "./identity-fixture.ts";

const UI_DIR = path.join(import.meta.dirname, "..", "src", "admin-ui");
const ui = (name: string) => readFileSync(path.join(UI_DIR, name), "utf8");
const lib = new Function(`${ACCESS_RULES_JS}; return { rulesOf, policyOf, isBroadRoot };`)() as {
  rulesOf: (p: Record<string, unknown>) => { defaultMode: string; rules: { path: string; perm: string }[] };
  policyOf: (p: Record<string, unknown>, name: string, root: string, mode: string, rules: { path: string; perm: string }[]) => Record<string, unknown>;
  isBroadRoot: (root: string) => boolean;
};
const base = { project_id: "scope", physical_root: "/scope" };

test("allow rules: explicit allow_globs are shown as Allow rules and an unrelated edit keeps them unchanged", () => {
  const stored = { ...base, mode: "read_write", writable_globs: ["temp/**"], deny_globs: ["*.key"], allow_globs: [".env"] };
  const { defaultMode, rules } = lib.rulesOf(stored);
  assert.deepEqual(rules.filter((r) => r.perm === "allow"), [{ path: ".env", perm: "allow" }]);
  assert.deepEqual(lib.policyOf(stored, "scope", "/scope", defaultMode, rules), stored, "round trip without loss");
  assert.deepEqual(lib.policyOf(stored, "renamed", "/scope", defaultMode, rules), { ...stored, project_id: "renamed" }, "an unrelated field edit keeps allow_globs");
});

test("allow rules: add and remove an Allow rule; blank and duplicate paths are dropped and the browser applies no precedence", () => {
  const p = { ...base, mode: "read_only" };
  const added = lib.policyOf(p, "scope", "/scope", "read_only", [{ path: " .env ", perm: "allow" }, { path: ".env", perm: "allow" }, { path: " ", perm: "allow" }]);
  assert.deepEqual(added, { ...p, allow_globs: [".env"] });
  assert.deepEqual(lib.policyOf(added, "scope", "/scope", "read_only", []), p, "removing the rule removes the field");
  const conflicting = lib.policyOf(p, "scope", "/scope", "read_only", [{ path: "x", perm: "allow" }, { path: "x", perm: "deny" }]);
  assert.deepEqual([conflicting.allow_globs, conflicting.deny_globs], [["x"], ["x"]], "the Server, not the browser, refuses a conflicting pair");
  assert.ok(!/precedence|beats|wins over an allow/i.test(ACCESS_RULES_JS.replace(/\/\/[^\n]*/g, "")), "no precedence engine in the browser code");
});

test("broad root: POSIX / and Windows drive roots need confirmation, ordinary roots and UNC shares do not", () => {
  for (const root of ["/", "//", " / ", "C:\\", "c:/", "D:", "Z:\\\\"]) assert.equal(lib.isBroadRoot(root), true, root);
  for (const root of ["/srv/web", "C:\\work", "\\\\host\\share", "", "relative"]) assert.equal(lib.isBroadRoot(root), false, root);
});

test("Projects: table edits autosave, the drawer saves only on Save changes, and a broad root is confirmed before the PUT is sent", () => {
  const src = ui("projects.ts");
  assert.ok(/Save changes/.test(src) && /"Cancel"/.test(src), "the drawer has explicit Save changes / Cancel");
  assert.ok(!/apply\(\)/.test(src) && /setTimeout\(save, autosaveDebounceMs\)/.test(src), "drawer edits stay in the draft; table edits keep the shared debounce");
  const save = src.slice(src.indexOf("async function save()"), src.indexOf("async function setAccess"));
  assert.ok(save.indexOf("isBroadRoot") !== -1 && save.indexOf("confirm(") !== -1 && save.indexOf("confirm(") < save.indexOf('api("PUT"'), "the confirmation precedes the request");
  assert.ok(/await load\(true\)/.test(save), "cancelling the confirmation reloads the Server state and sends nothing");
  assert.ok(!/delete.*client|uninstall/i.test(src.replace(/"Remove this project"/g, "")), "no Client delete or uninstall control");
});

test("Proposal review: items are decided one by one through the Server endpoints, approve-all is a convenience and an unusable file is visible", () => {
  const src = ui("proposals.ts");
  assert.ok(/api\("GET", "\/admin\/api\/proposal"\)/.test(src));
  assert.ok(/"\/admin\/api\/proposal\/" \+ encodeURIComponent\(p\.proposal_id\) \+ "\/items\/" \+ encodeURIComponent\(i\.item_id\) \+ "\/" \+ action/.test(src), "per-item approve and reject");
  assert.ok(/Approve all pending/.test(src) && /Reject all pending/.test(src));
  assert.ok(/unusable/.test(src) && /cannot be read/.test(src), "the unusable state is shown, never read as no proposal");
  assert.ok(!/status\s*=\s*"(approved|rejected)"/.test(src), "no UI-local decision state: the answer of the Server is reloaded");
  assert.ok(renderAdminPage().includes("renderProposals"), "the page includes it");
});

test("Clients: Machine UUID, friendly name, build and liveness come from the Server data", () => {
  const src = ui("clients.ts");
  assert.ok(/c\.machine_uuid/.test(src) && /c\.client_build/.test(src) && /ago\(c\.last_seen\)/.test(src));
  assert.equal(src.match(/cellToggle\("/g)?.length, 2, "Enable/Disable plus the per-Client Auto Update toggle");
  assert.ok(!/\/(delete|uninstall)\b/i.test(src), "removal is the Server-side Retire; the screen never asks for an uninstall");
});

test("System: logging level, size, retention and every runtime knob are controls that autosave through the config owner", () => {
  const src = ui("system.ts");
  for (const text of ["Logging", "Runtime", "level", "max_bytes", "retention_days", "Log level", "RUNTIME_KNOBS", "LOG_LEVELS"]) assert.ok(src.includes(text), text);
  assert.ok(renderAdminPage().includes("admin_autosave_debounce_ms") && renderAdminPage().includes("heartbeat_interval_ms"), "every runtime knob reaches the page from its one owner");
  assert.ok(/setTimeout\(saveSettings, autosaveDebounceMs\)/.test(src) && /api\("PUT", "\/admin\/api\/config"/.test(src));
  assert.ok(!/Save["']/.test(src.replace(/Autosaved|Saving…|Not saved/g, "")), "no Save button");
});

async function start() {
  const dir = mkdtempSync(path.join(tmpdir(), "reach-139-"));
  const config = new ServerConfigStore(path.join(dir, "config.json"));
  const connections = new ClientConnectionRegistry({ config, serverBuild: "srv-1", isBuildCompatible: () => true });
  const proposals = new ProposalStore({ path: path.join(dir, "proposal.json"), config, connections });
  const server = createServer(createAdminHandler({ config, connections, proposals, serverBuild: "srv-1" }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const put = (body: unknown) => fetch(`${url}/admin/api/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped JSON answers
  return { url, config, put, get: async (p: string) => (await fetch(`${url}${p}`)).json() as Promise<any>, close: () => { server.closeAllConnections(); connections.stop(); return new Promise<void>((r) => server.close(() => r())); } };
}

test("API: allow_globs round-trips through the config endpoint, and the Clients list carries machine_uuid and client_build", async () => {
  const rt = await start();
  const key = newIdentity();
  const project = { project_id: "web", physical_root: "/srv/web", mode: "read_only", allow_globs: [".env"], deny_globs: ["*.key"] };
  assert.equal((await rt.put({ mcp_bearer: "mcp-bearer-" + "Vt29Qw71", clients: [{ client_id: "laptop", display_name: "Work laptop", enabled: false, projects: [project] }] })).status, 200);
  const view = await rt.get("/admin/api/config");
  assert.deepEqual(view.clients[0].projects[0], project, "the view returns allow_globs");
  const again = view.clients.map((c: { client_id: string; display_name: string; enabled: boolean; projects: unknown[] }) => ({ client_id: c.client_id, display_name: c.display_name, enabled: c.enabled, projects: c.projects }));
  assert.equal((await rt.put({ clients: again })).status, 200, "the same edit the page sends is accepted");
  assert.deepEqual(rt.config.snapshot().clients[0]?.projects[0], project, "allow_globs survives the round trip");
  rt.config.registerPendingClient("newbox", key.publicKey, "New box", "0123456789abcdef0123456789abcdef".replace(/(.{8})(.{4})(.{4})(.{4})(.*)/, "$1-$2-$3-$4-$5"));
  const clients = await rt.get("/admin/api/clients");
  const row = clients.clients.find((c: { client_id: string }) => c.client_id === "newbox");
  assert.equal(row.machine_uuid, "01234567-89ab-cdef-0123-456789abcdef");
  assert.ok("client_build" in row, "the build field is always present (null while never connected)");
  assert.ok(!JSON.stringify(clients).includes(key.publicKey), "no key");
  await rt.close();
});
