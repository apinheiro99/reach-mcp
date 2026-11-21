// The Clients view: six counters, a search and status filter, and one table row per Client, built only from UI.* components and only
// from what /admin/api/clients answers. The Server owns every status, count and fingerprint; this view renders them, sends the human
// actions (Enable/Disable, Rotate Key) to the lifecycle API and reloads on the shell's one refresh cadence, so it holds no policy.
export const CLIENTS_CSS = `
.cl-conn{display:flex;flex-direction:column;gap:.15rem}
.cl-conn-state{display:flex;align-items:center;gap:var(--sp-2);font-weight:600}
.cl-dot{width:.7rem;height:.7rem;border-radius:50%;border:2px solid var(--c-muted);flex:none}
.cl-dot[data-online="true"]{background:var(--c-ok);border-color:var(--c-ok)}
.cl-seen{color:var(--c-muted);font-size:var(--fs-sm);padding-left:1.35rem}
.cl-fp{display:flex;align-items:center;gap:var(--sp-2);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--fs-sm);white-space:nowrap}
.cl-name{width:100%;min-width:9rem;font:inherit;font-weight:700;padding:.15rem .4rem}
.cl-actions{display:flex;align-items:center;gap:var(--sp-3)}
.cl-note{display:flex;align-items:center;gap:var(--sp-2);color:var(--c-muted)}
.cl-note strong{color:var(--c-warn)}
.cl-note .icon{width:1.1rem;height:1.1rem;color:var(--c-warn)}
.cl-empty{padding:var(--sp-5);text-align:center}
`;

export const CLIENTS_JS = `
const shortFingerprint = (f) => (f ? f.slice(0, 16) + "…" + f.slice(-8) : "—");
const STATUS_PILL = { enabled: ["Enabled", "ok", "check"], pending: ["Pending", "warn", "clock"], disabled: ["Disabled", "bad", "ban"] };
const FILTERS = [["all", "All statuses"], ["pending", "Pending"], ["enabled", "Enabled"], ["disabled", "Disabled"], ["online", "Online"], ["offline", "Offline"]];
const matchesFilter = (c, filter) => filter === "all" || c.status === filter || (filter === "online" && c.online) || (filter === "offline" && !c.online);
const matchesSearch = (c, text) => !text || [c.display_name, c.client_id, c.fingerprint].some((v) => (v || "").toLowerCase().includes(text));

async function renderClients(view) {
  const ui = { search: "", filter: "all", data: null, editing: false, timer: 0 };
  const stats = UI.el("div", {});
  const tableHost = UI.el("div", {});
  const toolbar = UI.toolbar(
    UI.search({ id: "client-search", placeholder: "Search by client name, UUID or fingerprint…", onInput: (v) => { ui.search = v.trim().toLowerCase(); draw(); } }),
    UI.select(FILTERS, "all", (v) => { ui.filter = v; draw(); }));
  view.replaceChildren(stats, toolbar, tableHost);

  async function act(path, done) {
    say("saving", "Saving…");
    const r = await api("POST", path);
    if (r.ok) say("saved", done + " · " + clock());
    else say("error", "Not done: " + ((r.json.problems || [r.json.result || "unexpected error"]).join("; ")));
    await load();
  }

  async function saveDisplayName(clientId, displayName) {
    say("saving", "Saving…");
    const r = await api("PUT", "/admin/api/clients/" + encodeURIComponent(clientId) + "/display-name", { display_name: displayName });
    if (r.ok) { ui.editing = false; ui.data.clients.find((c) => c.client_id === clientId).display_name = displayName.trim(); say("saved", "Autosaved · " + clock()); }
    else say("error", "Not saved: " + (r.json.problems || ["unexpected error"]).join("; "));
  }

  function scheduleDisplayNameSave(clientId, displayName) {
    ui.editing = true;
    say("editing", "Editing…");
    clearTimeout(ui.timer);
    ui.timer = setTimeout(() => saveDisplayName(clientId, displayName), 500);
  }

  const row = (c) => {
    const base = "/admin/api/clients/" + encodeURIComponent(c.client_id);
    const [label, tone, icon] = STATUS_PILL[c.status];
    const nameInput = UI.input({ value: c.display_name || "", placeholder: c.client_id, onInput: (v) => scheduleDisplayNameSave(c.client_id, v) });
    nameInput.classList.add("cl-name");
    nameInput.setAttribute("aria-label", "Client name");
    const name = UI.identity({ badgeImageSrc: "/admin/assets/reach-logo.png", title: nameInput, subtitle: c.client_id });
    const dot = UI.el("span", { className: "cl-dot" });
    dot.dataset.online = String(c.online);
    const conn = UI.el("div", { className: "cl-conn" }, UI.el("div", { className: "cl-conn-state" }, dot, c.online ? "Online" : "Offline"), UI.el("div", { className: "cl-seen", textContent: c.last_seen ? ago(c.last_seen) : "—" }));
    const fp = UI.el("div", { className: "cl-fp" }, UI.el("span", { textContent: shortFingerprint(c.fingerprint), title: c.fingerprint || "" }),
      c.fingerprint ? UI.iconButton("copy", "Copy fingerprint", () => navigator.clipboard.writeText(c.fingerprint).then(() => say("saved", "Fingerprint copied · " + clock()))) : "");
    const toggle = UI.toggle("", c.status === "enabled", (on) => act(base + (on ? "/enable" : "/disable"), on ? "Enabled" : "Disabled"));
    toggle.title = c.status === "enabled" ? "Disable this client" : "Enable this client";
    const rotate = UI.button("Rotate Key", { icon: "refresh", onClick: () => act(base + "/rotate-key", "Key rotated") });
    if (!c.online) { rotate.disabled = true; rotate.title = "The client must be online to rotate its key"; }
    return {
      tone: c.status === "pending" ? "warn" : undefined,
      cells: [name, UI.pill(label, tone, icon), conn, fp, UI.el("div", { className: "cl-actions" }, toggle, rotate)],
      note: c.status === "pending" ? UI.el("div", { className: "cl-note" }, UI.icon("info"), UI.el("strong", { textContent: "Awaiting approval." }), "Enable the client to grant access to projects.") : undefined,
    };
  };

  function draw() {
    if (!ui.data) return;
    const n = ui.data.counts;
    stats.replaceChildren(UI.stats([
      UI.stat({ icon: "users", value: n.total, label: "Total" }),
      UI.stat({ icon: "check-circle", value: n.enabled, label: "Enabled", tone: "ok" }),
      UI.stat({ icon: "clock", value: n.pending, label: "Pending", tone: "warn" }),
      UI.stat({ icon: "ban", value: n.disabled, label: "Disabled", tone: "bad" }),
      UI.stat({ icon: "wifi", value: n.online, label: "Online", tone: "ok" }),
      UI.stat({ icon: "wifi-off", value: n.offline, label: "Offline" })]));
    const shown = ui.data.clients.filter((c) => matchesFilter(c, ui.filter) && matchesSearch(c, ui.search));
    tableHost.replaceChildren(UI.card({ variant: "table", children: [shown.length
      ? UI.table(["Client", "Status", "Connection", "Public Key (Fingerprint)", "Actions"], shown.map(row))
      : UI.el("div", { className: "cl-empty" }, UI.unavailable(ui.data.clients.length ? "No client matches this search" : "No client has registered yet"))] }));
  }

  async function load() {
    if (ui.editing || tableHost.contains(document.activeElement)) return;
    const r = await api("GET", "/admin/api/clients");
    if (!r.ok) { say("error", "The Server did not answer"); return; }
    ui.data = r.json;
    draw();
  }

  await load();
  every(load);
}
`;
