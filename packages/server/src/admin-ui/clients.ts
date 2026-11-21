// The Clients view: six counters, a search and status filter, and one table row per Client, built only from UI.* components and only
// from what /admin/api/clients answers. The Server owns every status, count and fingerprint; this view renders them, sends the human
// actions (Enable/Disable, Rotate Key) to the lifecycle API and reloads on the shell's one refresh cadence, so it holds no policy.
export const CLIENTS_CSS = `
.cl-stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:var(--gap)}
.cl-toolbar{display:grid;grid-template-columns:minmax(0,1fr) minmax(12rem,16rem);gap:var(--gap)}
.cl-search{position:relative;display:flex;align-items:center}
.cl-search .icon{position:absolute;left:var(--sp-3);width:1.2rem;height:1.2rem;color:var(--c-muted);pointer-events:none}
.cl-search .input{padding-left:2.6rem}
.cl-toolbar .input{height:2.9rem;border-radius:var(--radius-card)}
.cl-client{display:flex;align-items:center;gap:var(--sp-3);min-width:0}
.cl-avatar{display:grid;place-items:center;width:2.6rem;height:2.6rem;flex:none;border-radius:var(--radius-control);background:var(--c-elevated);border:1px solid var(--c-border)}
.cl-avatar .icon{color:var(--c-accent)}
.cl-name{font-weight:700;font-size:var(--fs-md)}
.cl-id{color:var(--c-muted);font-size:var(--fs-sm)}
.cl-conn{display:flex;flex-direction:column;gap:.15rem}
.cl-conn-state{display:flex;align-items:center;gap:var(--sp-2);font-weight:600}
.cl-dot{width:.7rem;height:.7rem;border-radius:50%;border:2px solid var(--c-muted);flex:none}
.cl-dot[data-online="true"]{background:var(--c-ok);border-color:var(--c-ok)}
.cl-seen{color:var(--c-muted);font-size:var(--fs-sm);padding-left:1.35rem}
.cl-fp{display:flex;align-items:center;gap:var(--sp-2);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--fs-sm);white-space:nowrap}
.cl-actions{display:flex;align-items:center;gap:var(--sp-3)}
.cl-note{display:flex;align-items:center;gap:var(--sp-2);color:var(--c-muted)}
.cl-note strong{color:var(--c-warn)}
.cl-note .icon{width:1.1rem;height:1.1rem;color:var(--c-warn)}
.cl-empty{padding:var(--sp-5);text-align:center}
@container (max-width:75rem){.cl-stats{grid-template-columns:repeat(3,minmax(0,1fr))}}
@container (max-width:46rem){.cl-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.cl-toolbar{grid-template-columns:minmax(0,1fr)}}
`;

export const CLIENTS_JS = `
const shortFingerprint = (f) => (f ? f.slice(0, 16) + "…" + f.slice(-8) : "—");
const STATUS_PILL = { enabled: ["Enabled", "ok", "check"], pending: ["Pending", "warn", "clock"], disabled: ["Disabled", "bad", "ban"] };
const FILTERS = [["all", "All statuses"], ["pending", "Pending"], ["enabled", "Enabled"], ["disabled", "Disabled"], ["online", "Online"], ["offline", "Offline"]];
const matchesFilter = (c, filter) => filter === "all" || c.status === filter || (filter === "online" && c.online) || (filter === "offline" && !c.online);
const matchesSearch = (c, text) => !text || [c.display_name, c.client_id, c.fingerprint].some((v) => (v || "").toLowerCase().includes(text));

async function renderClients(view) {
  const ui = { search: "", filter: "all", data: null };
  const stats = UI.el("div", { className: "cl-stats" });
  const tableHost = UI.el("div", {});
  const toolbar = UI.el("div", { className: "cl-toolbar" },
    UI.el("div", { className: "cl-search" }, UI.icon("search"), UI.input({ id: "client-search", placeholder: "Search by client name or fingerprint…", onInput: (v) => { ui.search = v.trim().toLowerCase(); draw(); } })),
    UI.select(FILTERS, "all", (v) => { ui.filter = v; draw(); }));
  view.replaceChildren(stats, toolbar, tableHost);

  async function act(path, done) {
    say("saving", "Saving…");
    const r = await api("POST", path);
    if (r.ok) say("saved", done + " · " + clock());
    else say("error", "Not done: " + ((r.json.problems || [r.json.result || "unexpected error"]).join("; ")));
    await load();
  }

  const row = (c) => {
    const base = "/admin/api/clients/" + encodeURIComponent(c.client_id);
    const [label, tone, icon] = STATUS_PILL[c.status];
    const name = UI.el("div", { className: "cl-client" }, UI.el("div", { className: "cl-avatar" }, UI.icon("box")),
      UI.el("div", {}, UI.el("div", { className: "cl-name", textContent: c.display_name || c.client_id }), UI.el("div", { className: "cl-id", textContent: c.client_id })));
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
    stats.replaceChildren(
      UI.stat({ icon: "users", value: n.total, label: "Total" }),
      UI.stat({ icon: "check-circle", value: n.enabled, label: "Enabled", tone: "ok" }),
      UI.stat({ icon: "clock", value: n.pending, label: "Pending", tone: "warn" }),
      UI.stat({ icon: "ban", value: n.disabled, label: "Disabled", tone: "bad" }),
      UI.stat({ icon: "wifi", value: n.online, label: "Online", tone: "ok" }),
      UI.stat({ icon: "wifi-off", value: n.offline, label: "Offline" }));
    const shown = ui.data.clients.filter((c) => matchesFilter(c, ui.filter) && matchesSearch(c, ui.search));
    tableHost.replaceChildren(UI.card({ variant: "table", children: [shown.length
      ? UI.table(["Client", "Status", "Connection", "Public Key (Fingerprint)", "Actions"], shown.map(row))
      : UI.el("div", { className: "cl-empty" }, UI.unavailable(ui.data.clients.length ? "No client matches this search" : "No client has registered yet"))] }));
  }

  async function load() {
    const r = await api("GET", "/admin/api/clients");
    if (!r.ok) { say("error", "The Server did not answer"); return; }
    ui.data = r.json;
    draw();
  }

  await load();
  every(load);
}
`;
