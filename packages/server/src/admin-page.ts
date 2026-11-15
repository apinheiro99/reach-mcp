// The admin page: one static document with plain DOM code, no framework and no bundler. Fields autosave after a short
// pause; there is no Save button. The server is the authority on validity, the page only shows what it answers.
export const ADMIN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>REACH Server</title>
<style>
body{font:14px system-ui,sans-serif;margin:0 auto;max-width:60rem;padding:1rem;background:#fafafa;color:#222}
h1{font-size:1.3rem}fieldset{border:1px solid #ccc;margin:.8rem 0;padding:.6rem}legend{font-weight:600}
input,select{font:inherit;margin:.15rem .3rem .15rem 0}input[type=text],input[type=password]{width:16rem}
.project{border-left:3px solid #8ab;padding-left:.6rem;margin:.4rem 0}
#status{position:sticky;top:0;background:#fff;border:1px solid #ccc;padding:.3rem .6rem}
.bad{color:#b00020}.good{color:#176f2c}code{background:#eee;padding:0 .25rem}
</style></head><body>
<h1>REACH Server</h1>
<div id="status" role="status">Loading…</div>
<div id="setup" hidden><strong>Setup mode.</strong> No configuration is active, so ChatGPT and Clients are refused. Set an MCP bearer and add Clients below; the first valid state activates itself.</div>
<section id="health"></section>
<fieldset><legend>MCP bearer</legend>
<input id="bearer" type="password" autocomplete="new-password" placeholder="leave empty to keep the current one">
<small>At least 16 characters, no spaces. Only its digest is stored and it is never shown again.</small></fieldset>
<section id="clients"></section>
<button id="add-client" type="button">Add Client</button>
<script>
"use strict";
const DEBOUNCE_MS = 600;
const status = document.getElementById("status");
let model = { clients: [] };
let timer = null;
let saving = Promise.resolve();

const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
const say = (text, cls = "") => { status.textContent = text; status.className = cls; };
const api = async (method, path, body) => {
  const res = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => ({})) };
};
const lines = (text) => text.split(",").map((s) => s.trim()).filter(Boolean);

function schedule() {
  say("Editing…");
  clearTimeout(timer);
  timer = setTimeout(save, DEBOUNCE_MS);
}

function save() {
  clearTimeout(timer);
  saving = saving.then(async () => {
    say("Saving…");
    const bearer = document.getElementById("bearer").value;
    const edit = { clients: model.clients.map(({ has_credential, ...c }) => c) };
    if (bearer) edit.mcp_bearer = bearer;
    const r = await api("PUT", "/admin/api/config", edit);
    if (r.ok) { document.getElementById("bearer").value = ""; say("Saved", "good"); await refresh(false); }
    else say("Not saved: " + (r.json.problems || ["unexpected error"]).join("; "), "bad");
  });
  return saving;
}

function field(label, value, onInput, type = "text") {
  const input = el("input", { type, value });
  input.addEventListener("input", () => { onInput(input.value); schedule(); });
  return el("label", {}, label + " ", input);
}

function renderProject(client, project) {
  const mode = el("select", {}, el("option", { value: "read_only", textContent: "read only" }), el("option", { value: "read_write", textContent: "read write" }));
  mode.value = project.mode;
  mode.addEventListener("change", () => { project.mode = mode.value; schedule(); });
  const remove = el("button", { type: "button", textContent: "Remove project" });
  remove.addEventListener("click", () => { client.projects.splice(client.projects.indexOf(project), 1); render(); schedule(); });
  return el("div", { className: "project" },
    field("Project", project.project_id, (v) => (project.project_id = v)),
    field("Root on the Client host", project.physical_root, (v) => (project.physical_root = v)),
    el("label", {}, "Mode ", mode),
    field("Writable globs", (project.writable_globs || []).join(", "), (v) => (project.writable_globs = lines(v))),
    field("Extra deny globs", (project.deny_globs || []).join(", "), (v) => (project.deny_globs = lines(v))),
    remove);
}

function renderClient(client) {
  const enabled = el("input", { type: "checkbox", checked: client.enabled });
  enabled.addEventListener("change", () => { client.enabled = enabled.checked; schedule(); });
  const addProject = el("button", { type: "button", textContent: "Add project" });
  addProject.addEventListener("click", () => { client.projects.push({ project_id: "", physical_root: "", mode: "read_only" }); render(); schedule(); });
  const issue = el("button", { type: "button", textContent: client.has_credential ? "Replace credential" : "Generate credential" });
  const shown = el("div", {});
  issue.addEventListener("click", async () => {
    await save();
    const r = await api("POST", "/admin/api/clients/" + encodeURIComponent(client.client_id) + "/credential");
    if (!r.ok) return say("No credential: " + (r.json.problems || ["unexpected error"]).join("; "), "bad");
    client.has_credential = true;
    shown.replaceChildren(el("div", {}, "Shown once, copy it now: ", el("code", { textContent: r.json.result.credential })));
    say("Credential generated", "good");
  });
  const remove = el("button", { type: "button", textContent: "Remove Client" });
  remove.addEventListener("click", () => { model.clients.splice(model.clients.indexOf(client), 1); render(); schedule(); });
  return el("fieldset", {}, el("legend", { textContent: client.client_id || "new Client" }),
    field("Client id", client.client_id, (v) => (client.client_id = v)),
    field("Name", client.display_name || "", (v) => (client.display_name = v || undefined)),
    el("label", {}, enabled, " enabled"),
    el("span", { textContent: client.has_credential ? " credential set" : " no credential yet" }), issue, shown,
    ...client.projects.map((p) => renderProject(client, p)), addProject, remove);
}

function render() { document.getElementById("clients").replaceChildren(...model.clients.map(renderClient)); }

async function refresh(rebuild) {
  const [state, config] = await Promise.all([api("GET", "/admin/api/state"), api("GET", "/admin/api/config")]);
  document.getElementById("setup").hidden = !state.json.setup_mode;
  const h = state.json.health;
  const clients = h.clients.sessions.map((s) => s.client_id + (s.online ? " online" : " offline")).join(", ") || "none";
  document.getElementById("health").textContent = "Build " + h.server_build + " · up " + h.uptime_seconds + "s · config " + (h.config_active ? "active" : "not active") +
    " · Clients: " + clients + " · requests in flight " + h.requests.in_flight + ", done " + h.requests.completed + ", failed " + h.requests.failed + ", timed out " + h.requests.timed_out;
  if (rebuild) { model = { clients: config.json.clients }; render(); }
}

document.getElementById("bearer").addEventListener("input", schedule);
document.getElementById("add-client").addEventListener("click", () => { model.clients.push({ client_id: "", enabled: false, projects: [], has_credential: false }); render(); schedule(); });
refresh(true).then(() => say("Ready"));
setInterval(() => refresh(false), 5000);
</script></body></html>`;
