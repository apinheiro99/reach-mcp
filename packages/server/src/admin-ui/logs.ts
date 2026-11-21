// The Logs view: six counters, a search with source and severity filters and an explicit Refresh, over the events /admin/api/logs reads from the
// existing operational log and audit trail. The counters describe the events the Server returned (not the filtered rows). There is no tunnel
// source because nothing logs tunnel events. Refresh is automatic on the shell's one poller; the button just asks again.
export const LOGS_CSS = `
.lg-time{white-space:nowrap;color:var(--c-muted)}
.lg-source{display:flex;align-items:center;gap:var(--sp-2);white-space:nowrap}
.lg-source .icon{width:1.1rem;height:1.1rem;color:var(--c-accent)}
.lg-details{color:var(--c-muted)}
.lg-empty{padding:var(--sp-5);text-align:center}
`;

export const LOGS_JS = `
const SEVERITY_PILL = { success: ["Success", "ok", "check"], info: ["Info", "accent", "info"], warning: ["Warning", "warn", "alert"], error: ["Error", "bad", "ban"] };
const SOURCES = [["all", "All Sources"], ["server", "Server"], ["audit", "Audit"]];
const SEVERITIES = [["all", "All Severities"], ["success", "Success"], ["info", "Info"], ["warning", "Warning"], ["error", "Error"]];

async function renderLogs(view) {
  const ui = { search: "", source: "all", severity: "all", events: null, truncated: false };
  const stats = UI.el("div", {});
  const tableHost = UI.el("div", {});
  const refresh = UI.button("Refresh", { icon: "refresh", onClick: () => load() });
  view.replaceChildren(stats, UI.toolbar(
    UI.search({ id: "log-search", placeholder: "Search logs by event, client, project or details…", onInput: (v) => { ui.search = v.trim().toLowerCase(); draw(); } }),
    UI.select(SOURCES, "all", (v) => { ui.source = v; draw(); }),
    UI.select(SEVERITIES, "all", (v) => { ui.severity = v; draw(); }),
    refresh), tableHost);

  const matches = (e) => (ui.source === "all" || e.source === ui.source) && (ui.severity === "all" || e.severity === ui.severity)
    && (!ui.search || [e.event, e.client, e.project, e.details].some((v) => (v || "").toLowerCase().includes(ui.search)));

  const row = (e) => {
    const [label, tone, icon] = SEVERITY_PILL[e.severity];
    return [UI.el("span", { className: "lg-time", textContent: new Date(e.time).toLocaleString([], { hour12: false }) }),
      UI.el("span", { className: "lg-source" }, UI.icon(e.source === "audit" ? "shield" : "server"), e.source === "audit" ? "Audit" : "Server"),
      UI.pill(label, tone, icon), e.event, e.client || "—", UI.el("span", { className: "lg-details", textContent: e.details })];
  };

  function draw() {
    if (!ui.events) return;
    const all = ui.events;
    const n = (f) => all.filter(f).length;
    stats.replaceChildren(UI.stats([
      UI.stat({ icon: "layers", value: all.length, label: "Total Events" }),
      UI.stat({ icon: "alert", value: n((e) => e.severity === "warning"), label: "Warnings", tone: "warn" }),
      UI.stat({ icon: "ban", value: n((e) => e.severity === "error"), label: "Errors", tone: "bad" }),
      UI.stat({ icon: "users", value: n((e) => e.client), label: "Client Events" }),
      UI.stat({ icon: "server", value: n((e) => e.source === "server"), label: "Server Events" }),
      UI.stat({ icon: "shield", value: n((e) => e.source === "audit"), label: "Audit Events" })]));
    const shown = all.filter(matches);
    tableHost.replaceChildren(UI.card({ variant: "table", children: [shown.length
      ? UI.table(["Time", "Source", "Severity", "Event", "Client", "Details"], shown.map(row))
      : UI.el("div", { className: "lg-empty" }, UI.unavailable(all.length ? "No event matches these filters" : "No event has been logged yet"))] }));
  }

  async function load() {
    const r = await api("GET", "/admin/api/logs");
    if (!r.ok) { say("error", "The Server did not answer"); return; }
    ui.events = r.json.events;
    ui.truncated = r.json.truncated;
    draw();
  }

  await load();
  every(load);
}
`;
