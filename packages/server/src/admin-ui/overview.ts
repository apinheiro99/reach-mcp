// The Overview view: six counters, three status cards and three platform cards, built only from UI.* components and only from
// facts the Server already answers (/admin/api/state and /admin/api/config). What the API does not expose yet (the OpenAI
// tunnel, the private mount, recent administrative actions) is shown as an explicit "not exposed yet" state, never invented.
export const OVERVIEW_CSS = `
.ov-stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:var(--gap)}
.ov-mid{display:grid;grid-template-columns:435fr 450fr 435fr;gap:var(--gap);flex:1.15 1 0;min-height:17rem}
.ov-bottom{display:grid;grid-template-columns:410fr 440fr 485fr;gap:var(--gap);flex:1 1 0;min-height:12rem}
.donut-wrap{display:flex;align-items:center;gap:var(--sp-5);flex-wrap:wrap}
.donut{width:clamp(8rem,11vw,11rem);height:auto;flex:none}
.donut circle{fill:none;stroke-width:9}
.donut .track{stroke:var(--c-border)}
.donut .ok{stroke:var(--c-ok)}.donut .warn{stroke:var(--c-warn)}.donut .bad{stroke:var(--c-bad)}
.donut text{fill:var(--c-text);text-anchor:middle}
.donut .big{font-size:2rem;font-weight:700}.donut .small{font-size:.8rem;fill:var(--c-muted)}
.legend{flex:1;min-width:9rem;display:flex;flex-direction:column}
.legend-dot{width:.65rem;height:.65rem;border-radius:50%;flex:none;background:var(--c-ok)}
.legend-dot[data-tone="warn"]{background:var(--c-warn)}.legend-dot[data-tone="bad"]{background:var(--c-bad)}
.legend .row{padding:var(--sp-3) 0}
@container (max-width:75rem){.ov-stats{grid-template-columns:repeat(3,minmax(0,1fr))}.ov-mid,.ov-bottom{grid-template-columns:repeat(2,minmax(0,1fr))}}
@container (max-width:46rem){.ov-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.ov-mid,.ov-bottom{grid-template-columns:minmax(0,1fr)}}
`;

export const OVERVIEW_JS = `
const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s ago";
  return Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m ago";
};

// One status per Client, so the counters and the donut always add up: no enrolled key = pending, else enabled or disabled.
const clientStatus = (c) => (!c.has_public_key ? "pending" : c.enabled ? "enabled" : "disabled");

function donut(parts, total) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 120 120"); svg.setAttribute("class", "donut"); svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", total + " clients");
  const ring = (cls, len, offset) => {
    const c = document.createElementNS(ns, "circle");
    c.setAttribute("cx", "60"); c.setAttribute("cy", "60"); c.setAttribute("r", "48"); c.setAttribute("pathLength", "100"); c.setAttribute("class", cls);
    if (len !== null) { c.setAttribute("stroke-dasharray", len + " " + (100 - len)); c.setAttribute("stroke-dashoffset", String(-offset)); c.setAttribute("transform", "rotate(-90 60 60)"); }
    return c;
  };
  svg.append(ring("track", null, 0));
  let at = 0;
  for (const p of parts) { if (!p.count) continue; const len = (p.count / total) * 100; svg.append(ring(p.tone, len, at)); at += len; }
  const text = (cls, y, t) => { const n = document.createElementNS(ns, "text"); n.setAttribute("x", "60"); n.setAttribute("y", y); n.setAttribute("class", cls); n.textContent = t; return n; };
  svg.append(text("big", "63", String(total)), text("small", "80", "Clients"));
  return svg;
}

async function renderOverview(view) {
  const [state, config] = await Promise.all([api("GET", "/admin/api/state"), api("GET", "/admin/api/config")]);
  if (!state.ok || !config.ok) { view.replaceChildren(UI.card({ title: "Overview", icon: "info", children: [UI.unavailable("The Server did not answer the state request.")] })); return; }
  const h = state.json.health;
  const clients = config.json.clients;
  const sessions = h.clients.sessions;
  const online = sessions.filter((s) => s.online).length;
  const by = (name) => clients.filter((c) => clientStatus(c) === name).length;
  const count = { enabled: by("enabled"), pending: by("pending"), disabled: by("disabled") };
  const total = clients.length;

  const stats = UI.el("div", { className: "ov-stats" },
    UI.stat({ icon: "users", value: total, label: "Total Clients" }),
    UI.stat({ icon: "check-circle", value: count.enabled, label: "Enabled", tone: "ok" }),
    UI.stat({ icon: "clock", value: count.pending, label: "Pending", tone: "warn" }),
    UI.stat({ icon: "ban", value: count.disabled, label: "Disabled", tone: "bad" }),
    UI.stat({ icon: "wifi", value: online, label: "Online", tone: "ok" }),
    UI.stat({ icon: "wifi-off", value: total - online, label: "Offline" }));

  const legendRow = (tone, label, n) => {
    const row = UI.row({ title: label, aside: n + " (" + (total ? Math.round((n / total) * 100) : 0) + "%)" });
    const dot = UI.el("span", { className: "legend-dot" });
    dot.dataset.tone = tone;
    row.prepend(dot);
    return row;
  };
  const legend = UI.el("div", { className: "legend" }, legendRow("ok", "Enabled", count.enabled), legendRow("warn", "Pending", count.pending), legendRow("bad", "Disabled", count.disabled));
  const status = UI.card({ icon: "users", title: "Client Status", subtitle: "Distribution of clients by access status", children: [
    UI.el("div", { className: "donut-wrap" }, donut([{ tone: "ok", count: count.enabled }, { tone: "warn", count: count.pending }, { tone: "bad", count: count.disabled }], total), legend)] });

  const name = (id) => (clients.find((c) => c.client_id === id) || {}).display_name || id;
  const seen = (s) => s.last_seen;
  const recent = [...sessions].sort((a, b) => (seen(b) || 0) - (seen(a) || 0)).slice(0, 4);
  const activity = UI.card({ icon: "pulse", title: "Recent Client Activity", subtitle: "Latest client connection and status", children: recent.length
    ? recent.map((s) => UI.row({ icon: s.online ? "check-circle" : "wifi-off", tone: s.online ? "ok" : undefined, title: name(s.client_id), detail: s.online ? "Client connected (online)" : "Client offline", aside: seen(s) ? ago(seen(s)) : "never seen" }))
    : [UI.unavailable("No clients configured yet")] });

  const healthRow = (icon, title, pill) => UI.row({ icon, title, aside: pill });
  const failed = h.requests.failed + h.requests.timed_out;
  const health = UI.card({ icon: "layers", title: "Server Health", subtitle: "Health status of core server services", children: [
    healthRow("code", "API", h.status === "ok" ? UI.pill("Healthy", "ok", "check") : UI.pill("Degraded", "warn")),
    healthRow("file", "Configuration", h.config_active ? UI.pill("Active", "ok", "check") : UI.pill("Not active", "warn")),
    healthRow("wifi", "Client connections", UI.pill(h.clients.connected + " connected", h.clients.connected ? "ok" : undefined)),
    healthRow("pulse", "Requests", UI.pill(h.requests.completed + " done" + (failed ? " · " + failed + " failed" : ""), failed ? "warn" : "ok"))] });

  const tunnel = UI.card({ icon: "tunnel", title: "OpenAI Tunnel", subtitle: "Connection to OpenAI (ChatGPT / Assistants)", children: [UI.unavailable("Tunnel status is not exposed by the Server yet")] });
  const mount = UI.card({ icon: "folder", title: "Private Mount", subtitle: "Project storage (persistent)", children: [UI.unavailable("Mount status and usage are not exposed by the Server yet")] });
  const actions = UI.card({ icon: "bolt", title: "Latest Actions", subtitle: "Recent administrative actions on clients and platform", children: [UI.unavailable("The action history is not exposed by the Server yet")] });

  view.replaceChildren(stats, UI.el("div", { className: "ov-mid" }, status, activity, health), UI.el("div", { className: "ov-bottom" }, tunnel, mount, actions));
}
`;
