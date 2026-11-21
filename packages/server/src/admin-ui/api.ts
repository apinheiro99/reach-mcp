// The API view: counters, the implemented endpoints with their owner-reported status, the request counters and static integration notes.
// Everything comes from /admin/api/endpoints (the one endpoint catalog plus the Server's own counters). Request rate, p95 and latency are
// not measured by the Server, so they are shown as "Not measured" instead of invented numbers. No route is polled from here.
export const API_VIEW_CSS = `
.ap-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.ap-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:var(--gap)}
.ap-note{display:flex;gap:var(--sp-3);color:var(--c-muted);line-height:1.5}
.ap-note .icon{flex:none;margin-top:.1rem}
@container (max-width:60rem){.ap-grid{grid-template-columns:minmax(0,1fr)}}
`;

export const API_VIEW_JS = `
const ENDPOINT_PILL = { healthy: ["Healthy", "ok", "check"], not_configured: ["Not configured", "warn", "info"], unavailable: ["Unavailable", "bad", "ban"] };
const METHOD_TONE = { GET: "ok", POST: "accent", WS: "warn" };

async function renderApi(view) {
  const stats = UI.el("div", {});
  const body = UI.el("div", { className: "stack" });
  view.replaceChildren(stats, body);

  function draw(d) {
    const n = d.counts, q = d.requests;
    stats.replaceChildren(UI.stats([
      UI.stat({ icon: "layers", value: n.http, label: "HTTP Endpoints", tone: "accent" }),
      UI.stat({ icon: "wifi", value: n.websocket, label: "WebSocket", tone: "ok" }),
      UI.stat({ icon: "check-circle", value: n.healthy, label: "Healthy", tone: "ok" }),
      UI.stat({ icon: "ban", value: n.errors, label: "Errors", tone: n.errors ? "bad" : undefined }),
      UI.stat({ icon: "clock", value: "—", label: "Avg Latency (not measured)" }),
      UI.stat({ icon: "users", value: n.connected_clients, label: "Connected Clients" })]));
    const rows = d.endpoints.map((e) => { const [label, tone, icon] = ENDPOINT_PILL[e.status]; return [UI.pill(e.method, METHOD_TONE[e.method]), UI.el("span", { className: "ap-path", textContent: e.path }), e.purpose, UI.pill(label, tone, icon)]; });
    const metric = (icon, title, aside) => UI.row({ icon, title, aside });
    body.replaceChildren(
      UI.card({ icon: "layers", title: "Core Endpoints", subtitle: "Implemented routes; status is reported by their owners", variant: "table", children: [UI.table(["Method", "Path", "Purpose", "Status"], rows)] }),
      UI.el("div", { className: "ap-grid" },
        UI.card({ icon: "pulse", title: "Runtime Metrics", children: [
          metric("check-circle", "Requests completed", String(q.completed)), metric("ban", "Requests failed", String(q.failed)), metric("clock", "Requests timed out", String(q.timed_out)),
          metric("bolt", "Requests in flight", String(q.in_flight)), metric("wifi", "WebSocket sessions", n.connected_clients + " active"), metric("info", "Request rate · p95 latency", "Not measured")] }),
        UI.card({ icon: "info", title: "Integration Notes", children: [UI.el("div", { className: "ap-note" }, UI.icon("info"),
          "The REACH MCP UI is a thin API client for the MCP server: management, monitoring and configuration go through the HTTP and WebSocket endpoints. All changes are autosaved automatically.")] })));
  }

  async function load() {
    const r = await api("GET", "/admin/api/endpoints");
    if (!r.ok) { say("error", "The Server did not answer"); return; }
    draw(r.json);
  }

  await load();
  every(load);
}
`;
