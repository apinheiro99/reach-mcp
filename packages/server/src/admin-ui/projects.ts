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

// The pure mapping between the one canonical policy object and the drawer's rule list. No second policy model: a rule is a
// view of writable_globs (Read / Write) or deny_globs (Deny); the default mode plus the write rules derive mode.
export const ACCESS_RULES_JS = `
const rulesOf = (p) => ({
  defaultMode: p.mode === "read_write" && p.writable_globs === undefined ? "read_write" : "read_only",
  rules: [...(p.writable_globs || []).map((path) => ({ path, perm: "write" })), ...(p.deny_globs || []).map((path) => ({ path, perm: "deny" })), ...(p.allow_globs || []).map((path) => ({ path, perm: "allow" }))],
});
const globsOf = (rules, perm) => [...new Set(rules.filter((r) => r.perm === perm).map((r) => r.path.trim()).filter(Boolean))];
const policyOf = (p, name, root, defaultMode, rules) => {
  const { mode, writable_globs, deny_globs, allow_globs, ...rest } = p;
  const writes = globsOf(rules, "write"), denies = globsOf(rules, "deny"), allows = globsOf(rules, "allow");
  return { ...rest, project_id: name.trim(), physical_root: root.trim(),
    mode: defaultMode === "read_write" || writes.length ? "read_write" : "read_only",
    ...(defaultMode !== "read_write" && writes.length ? { writable_globs: writes } : {}),
    ...(denies.length ? { deny_globs: denies } : {}),
    ...(allows.length ? { allow_globs: allows } : {}) };
};
// A UX warning only: the POSIX root or a Windows drive root. The Server stays the authority on whether a root is valid.
const isBroadRoot = (root) => /^(\\/+|[A-Za-z]:[\\\\/]*)$/.test(String(root).trim());
`;

export const PROJECTS_JS = ACCESS_RULES_JS + `
const MODES = [["read_only", "Read Only"], ["read_write", "Read / Write"]];
const RULE_PERMS = [["write", "Read / Write"], ["allow", "Allow"], ["deny", "Deny"]];
const statusOfClient = (c) => (c.enabled ? "enabled" : c.pending ? "pending" : "disabled");
// Only a brand-new draft that is still empty is held back. A persisted project is always sent, even with a cleared id or root, so the
// Server's canonical schema refuses it atomically instead of the replacement silently deleting it.
const filledProject = (p) => p.project_id.trim() !== "" && p.physical_root.trim() !== "";
const sendable = (p) => !p._draft || filledProject(p);

async function renderProjects(view) {
  const ui = { data: null, search: "", client: "all", dirty: false, rev: 0, timer: null, confirmed: new Set() };
  const proposalHost = UI.el("div", {});
  const proposals = renderProposals(proposalHost, () => load(true));
  const rootKey = (c, p) => c.client_id + "/" + p.project_id + "@" + p.physical_root.trim();
  const stats = UI.el("div", {});
  const tableHost = UI.el("div", {});
  const clientFilter = UI.el("div", {});
  const toolbar = UI.toolbar(
    UI.search({ id: "project-search", placeholder: "Search by client, project or root path…", onInput: (v) => { ui.search = v.trim().toLowerCase(); drawTable(); } }),
    clientFilter,
    UI.button("Add project", { icon: "plus", onClick: () => { const c = ui.data.clients.find((x) => x.client_id === ui.client) || ui.data.clients[0]; if (c) newProject(c); } }));
  view.replaceChildren(stats, proposalHost, toolbar, tableHost);

  const rows = () => ui.data.clients.flatMap((c) => (ui.client === "all" || ui.client === c.client_id ? (c.projects.length ? c.projects.map((p) => ({ c, p })) : [{ c, p: null }]) : []));
  const matches = ({ c, p }) => !ui.search || [c.display_name, c.client_id, p && p.project_id, p && p.physical_root].some((v) => (v || "").toLowerCase().includes(ui.search));

  function change() {
    ui.dirty = true; ui.rev++;
    say("editing", "Editing…");
    clearTimeout(ui.timer);
    ui.timer = setTimeout(save, autosaveDebounceMs);
  }

  async function save() {
    const rev = ui.rev;
    // A broad root is confirmed once, before anything is sent; cancelling reloads the Server state and emits no request. While a root field is
    // still being typed the check waits, because "/" is the first character of every absolute path.
    const broad = ui.data.clients.flatMap((c) => c.projects.filter(sendable).filter((p) => isBroadRoot(p.physical_root) && !ui.confirmed.has(rootKey(c, p))).map((p) => ({ c, p })));
    if (broad.length) {
      if (document.activeElement && document.activeElement.dataset && document.activeElement.dataset.root) { ui.timer = setTimeout(save, autosaveDebounceMs); return; }
      if (!confirm("This grants the whole root (" + broad.map(({ p }) => p.physical_root.trim()).join(", ") + ") to the project. Every file under it becomes reachable, subject to the Access Rules. Continue?")) { await load(true); say("saved", "Not applied · " + clock()); return; }
      for (const { c, p } of broad) ui.confirmed.add(rootKey(c, p));
    }
    const clients = ui.data.clients.map((c) => ({ client_id: c.client_id, ...(c.display_name ? { display_name: c.display_name } : {}), enabled: c.enabled,
      projects: c.projects.filter(sendable).map(({ _draft, ...p }) => p) }));
    say("saving", "Saving…");
    const r = await api("PUT", "/admin/api/config", { clients });
    if (!r.ok) { say("error", "Not saved: " + (r.json.problems || ["unexpected error"]).join("; ")); return; }
    if (rev === ui.rev) ui.dirty = false;
    for (const c of ui.data.clients) for (const p of c.projects) if (filledProject(p)) delete p._draft;
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
  const host = UI.el("div", {});
  document.body.append(host);

  // The access drawer edits the working project directly: every change writes the canonical policy back and autosaves through the same debounce.
  function openAccess(c, p) {
    const draft = { name: p.project_id, root: p.physical_root, tab: "access", ...rulesOf(p) };
    const close = () => { host.replaceChildren(); drawTable(); };
    const body = UI.el("div", { className: "stack" });
    const current = () => policyOf(p, draft.name, draft.root, draft.defaultMode, draft.rules);
    const tone = (perm) => (perm === "deny" ? "bad" : "ok");
    const apply = () => {
      const next = current();
      for (const k of ["writable_globs", "deny_globs", "allow_globs"]) delete p[k];
      Object.assign(p, next);
      change();
    };
    const pathBox = (value, onInput) => { const input = UI.input({ kind: "path", value, placeholder: "/absolute/path/on/the/client", onInput }); input.dataset.root = "1"; return UI.el("div", { className: "pj-root" }, UI.icon("folder"), input); };
    function accessTab() {
      const defaults = UI.select(MODES, draft.defaultMode, (v) => { draft.defaultMode = v; apply(); redraw(); });
      const ruleRows = draft.rules.map((r, i) => {
        const perm = UI.select(draft.defaultMode === "read_write" ? RULE_PERMS.filter(([v]) => v !== "write") : RULE_PERMS, r.perm, (v) => { r.perm = v; perm.dataset.tone = tone(v); apply(); });
        perm.dataset.tone = tone(r.perm);
        const path = UI.el("div", { className: "rule-path" }, UI.icon("folder"), UI.input({ kind: "path", value: r.path, placeholder: "temp/** or docs/readme.md", onInput: (v) => { r.path = v; apply(); } }));
        return [String(i + 1), path, perm, UI.iconButton("trash", "Remove this rule", () => { draft.rules.splice(i, 1); apply(); redraw(); })];
      });
      return [
        UI.card({ title: "Project configuration", children: [UI.el("div", { className: "form-grid" }, UI.field("Project name", UI.input({ value: draft.name, placeholder: "project-id", onInput: (v) => { draft.name = v; apply(); } })), UI.field("Root (base path on the client)", pathBox(draft.root, (v) => { draft.root = v; apply(); }))), UI.field("Default access mode", defaults),
          UI.el("p", { className: "hint", textContent: "Applies to the whole project. Read / Write makes the whole root writable; Read Only lets the Read / Write rules below open only the paths they name." })] }),
        UI.card({ title: "Access rules", subtitle: "Exact files or globs relative to the root. The order of rules does not matter; the Server decides which rule applies (Deny, then Allow, then the built-in protections).", children: [
          UI.el("div", { className: "actions" }, UI.button("Add rule", { variant: "accent", icon: "plus", onClick: () => { draft.rules.push({ path: "", perm: draft.defaultMode === "read_write" ? "deny" : "write" }); redraw(); } })),
          ruleRows.length ? UI.table(["#", "Path (relative to root)", "Permission", "Actions"], ruleRows) : UI.unavailable("No rules: the default access applies to the whole project")] }),
        UI.card({ variant: "inset", icon: "info", title: "How it works", children: [UI.el("ul", { className: "info-list" },
          UI.el("li", { textContent: "The default access applies to the whole project root and reading stays open everywhere except Deny paths." }),
          UI.el("li", { textContent: "Under Read Only, a Read / Write rule (temp/**, docs/**, .gitlab-ci.yml, .githooks/**) opens only that path for writing." }),
          UI.el("li", { textContent: "Globs: ** crosses folders, * stays in one folder. An Allow rule explicitly opens a path the built-in protections would deny (for example .env); the .git store always stays closed." }),
          UI.el("li", { textContent: "Write actions (create, edit, delete) work inside the root; delete moves the file to .lixeira and never unlinks." }))] })];
    }
    const configTab = () => [UI.card({ title: "Canonical policy", subtitle: "The exact object the Client enforces (read-only view of what autosave writes).", children: [UI.el("pre", { className: "json-view", textContent: JSON.stringify(current(), null, 2) })] })];
    const detailsTab = () => [UI.card({ title: "Details", children: [
      UI.row({ icon: "user", title: "Client", detail: c.display_name || c.client_id, aside: c.client_id }),
      UI.row({ icon: "box", title: "Project", detail: draft.name || "(new)" }),
      UI.row({ icon: "folder", title: "Root", detail: draft.root || "(not set)" }),
      UI.row({ icon: "shield", title: "Default access", detail: draft.defaultMode === "read_write" ? "Read / Write" : "Read Only" }),
      UI.row({ icon: "check-circle", title: "Rules", detail: draft.rules.filter((r) => r.perm === "write").length + " Read / Write, " + draft.rules.filter((r) => r.perm === "allow").length + " Allow, " + draft.rules.filter((r) => r.perm === "deny").length + " Deny" })] })];
    const TABS = [["access", "Access & Permissions", "shield"], ["config", "Configuration (JSON)", "code"], ["details", "Details", "info"]];
    function redraw() {
      body.replaceChildren(UI.tabs(TABS, draft.tab, (id) => { draft.tab = id; redraw(); }), ...(draft.tab === "config" ? configTab() : draft.tab === "details" ? detailsTab() : accessTab()));
    }
    redraw();
    host.replaceChildren(UI.drawer({ icon: "folder", title: "Project: " + (p.project_id || "new"), subtitle: "Client: " + (c.display_name || c.client_id), onClose: close, children: [body],
      footer: [UI.el("span", { className: "hint", textContent: "Changes are autosaved." }), UI.button("Close", { onClick: close })] }));
  }

  const row = ({ c, p }) => {
    const status = statusOfClient(c);
    const who = UI.identity({ badgeImageSrc: "/admin/assets/reach-logo.png", title: c.display_name || c.client_id, subtitle: c.client_id });
    const toggle = UI.toggle("", c.enabled, (on) => setAccess(c, on));
    toggle.title = c.enabled ? "Disable this client" : "Enable this client";
    const access = UI.el("div", { className: "pj-actions" }, toggle, status === "pending" ? UI.pill("Pending", "warn") : "");
    if (!p) return { tone: status === "pending" ? "warn" : undefined, cells: [who, UI.unavailable("No project yet"), "", "", access, UI.el("div", { className: "pj-actions" }, UI.iconButton("plus", "Add a project", () => newProject(c)))] };
    const id = UI.input({ value: p.project_id, placeholder: "project-id", onInput: (v) => { p.project_id = v.trim(); change(); } });
    const rootInput = UI.input({ kind: "path", value: p.physical_root, placeholder: "/absolute/path/on/the/client", onInput: (v) => { p.physical_root = v.trim(); change(); } });
    rootInput.dataset.root = "1";
    const root = UI.el("div", { className: "pj-root" }, UI.icon("folder"), rootInput);
    const mode = UI.select(MODES, p.mode, (v) => { p.mode = v; if (v === "read_only") delete p.writable_globs; change(); });
    return {
      tone: status === "pending" ? "warn" : undefined,
      cells: [who, id, root, mode, access, UI.el("div", { className: "pj-actions" }, UI.iconButton("shield", "Edit access and permissions", () => openAccess(c, p)), UI.iconButton("trash", "Remove this project", () => removeProject(c, p)))],
    };
  };

  function drawStats() {
    const all = ui.data.clients.flatMap((c) => c.projects.filter(sendable).map((p) => ({ c, p })));
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
    proposals.refresh();
    if (!force && (ui.dirty || tableHost.contains(document.activeElement))) return;
    const r = await api("GET", "/admin/api/config");
    if (!r.ok) { say("error", "The Server did not answer"); return; }
    ui.data = r.json;
    ui.dirty = false;
    for (const c of ui.data.clients) for (const p of c.projects) if (isBroadRoot(p.physical_root)) ui.confirmed.add(rootKey(c, p));
    if (ui.client !== "all" && !ui.data.clients.some((c) => c.client_id === ui.client)) ui.client = "all";
    drawStats(); drawFilter(); drawTable();
  }

  await load(true);
  every(load);
}
`;
