// The Projects view: six counters, a search and Client filter, and one row per Client project (Client, Project, Root Path, Policy,
// Access), built only from UI.* components. The Server owns validity: every edit is autosaved (~500 ms, no Save button) through the one
// config endpoint and the Server's refusal is shown as it is. Access reuses the Clients lifecycle endpoint; the view never touches a key.
export const PROJECTS_CSS = `
.pj-root{position:relative;display:flex;align-items:center;min-width:14rem}
.pj-root .icon{position:absolute;left:var(--sp-3);width:1.1rem;height:1.1rem;color:var(--c-accent);pointer-events:none}
.pj-root .input{padding-left:2.4rem;border-radius:var(--radius-control)}
.pj-actions{display:flex;align-items:center;gap:var(--sp-2)}
.pj-empty{padding:var(--sp-5);text-align:center}
`;

export const PROJECTS_JS = `
const MODES = [["read_only", "Read Only"], ["read_write", "Read / Write"]];
const statusOfClient = (c) => (c.enabled ? "enabled" : c.pending ? "pending" : "disabled");
const validProject = (p) => p.project_id.trim() !== "" && p.physical_root.startsWith("/");

async function renderProjects(view) {
  const ui = { data: null, search: "", client: "all", dirty: false, rev: 0, timer: null };
  const stats = UI.el("div", {});
  const tableHost = UI.el("div", {});
  const clientFilter = UI.el("div", {});
  const toolbar = UI.toolbar(
    UI.search({ id: "project-search", placeholder: "Search by client, project or root path…", onInput: (v) => { ui.search = v.trim().toLowerCase(); drawTable(); } }),
    clientFilter);
  view.replaceChildren(stats, toolbar, tableHost);

  const rows = () => ui.data.clients.flatMap((c) => (ui.client === "all" || ui.client === c.client_id ? (c.projects.length ? c.projects.map((p) => ({ c, p })) : [{ c, p: null }]) : []));
  const matches = ({ c, p }) => !ui.search || [c.display_name, c.client_id, p && p.project_id, p && p.physical_root].some((v) => (v || "").toLowerCase().includes(ui.search));

  function change() {
    ui.dirty = true; ui.rev++;
    say("editing", "Editing…");
    clearTimeout(ui.timer);
    ui.timer = setTimeout(save, 500);
  }

  async function save() {
    const rev = ui.rev;
    const clients = ui.data.clients.map((c) => ({ client_id: c.client_id, ...(c.display_name ? { display_name: c.display_name } : {}), enabled: c.enabled,
      projects: c.projects.filter(validProject).map(({ _draft, ...p }) => p) }));
    say("saving", "Saving…");
    const r = await api("PUT", "/admin/api/config", { clients });
    if (!r.ok) { say("error", "Not saved: " + (r.json.problems || ["unexpected error"]).join("; ")); return; }
    if (rev === ui.rev) ui.dirty = false;
    for (const c of ui.data.clients) for (const p of c.projects) if (validProject(p)) delete p._draft;
    say("saved", "Autosaved · " + clock());
    drawStats();
  }

  async function setAccess(c, on) {
    if (ui.dirty) { clearTimeout(ui.timer); await save(); }
    say("saving", "Saving…");
    const r = await api("POST", "/admin/api/clients/" + encodeURIComponent(c.client_id) + (on ? "/enable" : "/disable"));
    if (r.ok) say("saved", (on ? "Enabled" : "Disabled") + " · " + clock());
    else say("error", "Not done: " + (r.json.problems || ["unexpected error"]).join("; "));
    await load(true);
  }

  const newProject = (c) => { c.projects.push({ project_id: "", physical_root: "", mode: "read_only", _draft: true }); drawTable(); };
  const removeProject = (c, p) => { c.projects.splice(c.projects.indexOf(p), 1); drawTable(); change(); };

  const row = ({ c, p }) => {
    const status = statusOfClient(c);
    const who = UI.identity({ icon: "box", title: c.display_name || c.client_id, subtitle: c.client_id });
    const toggle = UI.toggle("", c.enabled, (on) => setAccess(c, on));
    toggle.title = c.enabled ? "Disable this client" : "Enable this client";
    const access = UI.el("div", { className: "pj-actions" }, toggle, status === "pending" ? UI.pill("Pending", "warn") : "");
    if (!p) return { tone: status === "pending" ? "warn" : undefined, cells: [who, UI.unavailable("No project yet"), "", "", access, UI.el("div", { className: "pj-actions" }, UI.iconButton("plus", "Add a project", () => newProject(c)))] };
    const id = UI.input({ value: p.project_id, placeholder: "project-id", onInput: (v) => { p.project_id = v.trim(); change(); } });
    const root = UI.el("div", { className: "pj-root" }, UI.icon("folder"), UI.input({ kind: "path", value: p.physical_root, placeholder: "/absolute/path/on/the/client", onInput: (v) => { p.physical_root = v.trim(); change(); } }));
    const mode = UI.select(MODES, p.mode, (v) => { p.mode = v; change(); });
    return {
      tone: status === "pending" ? "warn" : undefined,
      cells: [who, id, root, mode, access, UI.el("div", { className: "pj-actions" }, UI.iconButton("plus", "Add a project", () => newProject(c)), UI.iconButton("trash", "Remove this project", () => removeProject(c, p)))],
    };
  };

  function drawStats() {
    const all = ui.data.clients.flatMap((c) => c.projects.filter(validProject).map((p) => ({ c, p })));
    const of = (status) => all.filter(({ c }) => statusOfClient(c) === status).length;
    stats.replaceChildren(UI.stats([
      UI.stat({ icon: "box", value: all.length, label: "Projects" }),
      UI.stat({ icon: "users", value: ui.data.clients.filter((c) => c.projects.length).length, label: "Mapped Clients" }),
      UI.stat({ icon: "database", value: new Set(all.map(({ p }) => p.physical_root)).size, label: "Roots", tone: "accent" }),
      UI.stat({ icon: "shield", value: all.filter(({ p }) => p.mode === "read_write").length, label: "Read / Write", tone: "accent" }),
      UI.stat({ icon: "check-circle", value: of("enabled"), label: "Active", tone: "ok" }),
      UI.stat({ icon: "clock", value: of("pending"), label: "Pending Review", tone: "warn" })]));
  }

  function drawTable() {
    const shown = rows().filter(matches);
    tableHost.replaceChildren(UI.card({ variant: "table", children: [shown.length
      ? UI.table(["Client", "Project", "Root Path", "Policy", "Access", "Actions"], shown.map(row))
      : UI.el("div", { className: "pj-empty" }, UI.unavailable(ui.data.clients.length ? "No project matches this search" : "No client has registered yet"))] }));
  }

  function drawFilter() {
    clientFilter.replaceChildren(UI.select([["all", "All clients"], ...ui.data.clients.map((c) => [c.client_id, c.display_name || c.client_id])], ui.client, (v) => { ui.client = v; drawTable(); }));
  }

  async function load(force) {
    if (!force && (ui.dirty || tableHost.contains(document.activeElement))) return;
    const r = await api("GET", "/admin/api/config");
    if (!r.ok) { say("error", "The Server did not answer"); return; }
    ui.data = r.json;
    ui.dirty = false;
    if (ui.client !== "all" && !ui.data.clients.some((c) => c.client_id === ui.client)) ui.client = "all";
    drawStats(); drawFilter(); drawTable();
  }

  await load(true);
  every(load);
}
`;
