// The Clients view: six counters, a search and status filter, and one table row per Client, built only from UI.* components and only
// from what /admin/api/clients answers. The Server owns every status, count and fingerprint; this view renders them, sends the human
// actions (Enable/Disable, Update Client, Rotate Key) to the lifecycle API and reloads on the shell's one refresh cadence, so it holds no policy.
export const CLIENTS_CSS = `
.cl-conn{display:flex;flex-direction:column;gap:.15rem}
.cl-conn-state{display:flex;align-items:center;gap:var(--sp-2);font-weight:600}
.cl-detail{color:var(--c-muted);font-size:var(--fs-sm)}
.cl-detail[data-tone="warn"]{color:var(--c-warn)}
.cl-detail[data-tone="bad"]{color:var(--c-bad)}
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
// The one operational state of a Client, from what the Server answered: no live session is Offline, a live session the Server marked
// compatible=false is Incompatible (it is connected, never Offline), any other live session is Online. The browser compares no versions.
const operationalState = (c) => (!c.online ? "offline" : c.compatible === false ? "incompatible" : "online");
const STATE_PILL = { online: ["Online", "ok", "wifi"], offline: ["Offline", "bad", "wifi-off"], incompatible: ["Incompatible", "warn", "alert"] };
const AUTH_LABEL = { enabled: "Enabled", pending: "Pending approval", disabled: "Disabled" };
const UPDATE_TEXT = { requested: "Update requested…", staging: "Updating: downloading and verifying…", restarting: "Update applied: the Client is restarting", failed: "Update failed" };
const FILTERS = [["all", "All statuses"], ["online", "Online"], ["offline", "Offline"], ["incompatible", "Incompatible"], ["pending", "Pending"], ["enabled", "Enabled"], ["disabled", "Disabled"]];
const matchesFilter = (c, filter) => filter === "all" || c.status === filter || operationalState(c) === filter;
// Update is offered only when the Server's own facts allow it; the Server still decides and its refusal is shown as it is.
const updateBlock = (c) => (!c.online ? "The Client must be online to update" : c.update_capable !== true ? "This build cannot update remotely: run the installer once on the host" : c.update && c.update.state !== "failed" ? "An update is already in progress" : "");
const matchesSearch = (c, text) => !text || [c.display_name, c.client_id, c.fingerprint].some((v) => (v || "").toLowerCase().includes(text));

async function renderClients(view) {
  const ui = { search: "", filter: "all", data: null, editing: false, timer: 0 };
  let serverBuild = "";
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
    ui.timer = setTimeout(() => saveDisplayName(clientId, displayName), autosaveDebounceMs);
  }

  const row = (c) => {
    const base = "/admin/api/clients/" + encodeURIComponent(c.client_id);
    const state = operationalState(c);
    const [label, tone, icon] = STATE_PILL[state];
    const nameInput = UI.input({ value: c.display_name || "", placeholder: c.client_id, onInput: (v) => scheduleDisplayNameSave(c.client_id, v) });
    nameInput.classList.add("cl-name");
    nameInput.setAttribute("aria-label", "Client name");
    const name = UI.identity({ badgeImageSrc: "/admin/assets/reach-logo.png", title: nameInput, subtitle: c.machine_uuid && c.machine_uuid !== c.client_id ? c.client_id + " · UUID " + c.machine_uuid : c.client_id });
    const detail = (text, tone) => { const d = UI.el("div", { className: "cl-detail", textContent: text }); if (tone) d.dataset.tone = tone; return d; };
    const conn = UI.el("div", { className: "cl-conn" }, UI.el("div", { className: "cl-conn-state" }, UI.pill(label, tone, icon)),
      state === "incompatible" ? detail("Build " + c.client_build + " is not accepted by this Server (build " + serverBuild + "): update it to manage it again", "warn") : "",
      detail((c.online ? "Connected · " : "Last seen ") + (c.last_seen ? ago(c.last_seen) : "—") + (c.client_build && state !== "incompatible" ? " · build " + c.client_build : "")),
      c.update ? detail(UPDATE_TEXT[c.update.state] + (c.update.reason ? ": " + c.update.reason : ""), c.update.state === "failed" ? "bad" : "warn") : "");
    const fp = UI.el("div", { className: "cl-fp" }, UI.el("span", { textContent: shortFingerprint(c.fingerprint), title: c.fingerprint || "" }),
      c.fingerprint ? UI.iconButton("copy", "Copy fingerprint", () => navigator.clipboard.writeText(c.fingerprint).then(() => say("saved", "Fingerprint copied · " + clock()))) : "");
    const toggle = UI.toggle(AUTH_LABEL[c.status], c.status === "enabled", (on) => act(base + (on ? "/enable" : "/disable"), on ? "Enabled" : "Disabled"));
    toggle.title = c.status === "enabled" ? "Disable this client" : "Enable this client";
    const update = UI.button("Update Client", { icon: "refresh", onClick: () => act(base + "/update", "Update requested") });
    const blocked = updateBlock(c);
    if (blocked) { update.disabled = true; update.title = blocked; }
    const rotate = UI.button("Rotate Key", { icon: "refresh", onClick: () => act(base + "/rotate-key", "Key rotated") });
    if (state !== "online") { rotate.disabled = true; rotate.title = state === "incompatible" ? "An incompatible client cannot rotate its key: update it first" : "The client must be online to rotate its key"; }
    return {
      tone: c.status === "pending" ? "warn" : undefined,
      cells: [name, conn, fp, UI.el("div", { className: "cl-actions" }, toggle, update, rotate)],
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
      UI.stat({ icon: "alert", value: n.incompatible, label: "Incompatible", tone: "warn" }),
      UI.stat({ icon: "wifi-off", value: n.offline, label: "Offline" })]));
    const shown = ui.data.clients.filter((c) => matchesFilter(c, ui.filter) && matchesSearch(c, ui.search));
    tableHost.replaceChildren(UI.card({ variant: "table", children: [shown.length
      ? UI.table(["Client", "Status", "Public Key (Fingerprint)", "Actions"], shown.map(row))
      : UI.el("div", { className: "cl-empty" }, UI.unavailable(ui.data.clients.length ? "No client matches this search" : "No client has registered yet"))] }));
  }

  async function load() {
    if (ui.editing || tableHost.contains(document.activeElement)) return;
    const r = await api("GET", "/admin/api/clients");
    if (!r.ok) { say("error", "The Server did not answer"); return; }
    ui.data = r.json;
    serverBuild = r.json.server_build;
    draw();
  }

  await load();
  every(load);
}
`;
