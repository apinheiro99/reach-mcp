// The System view: the Server identity card, storage, tunnel, runtime services, update and environment cards, built from /admin/api/system.
// Only what the Server can truthfully know is shown. The tunnel and the update machinery belong to the deployment, so those cards say so
// instead of showing invented values; host inventory the Server cannot read is not drawn at all.
export const SYSTEM_CSS = `
.sy-top{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:var(--gap)}
.sy-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:var(--gap)}
.sy-brand{display:flex;align-items:center;gap:var(--sp-4)}
.sy-brand img{width:4.5rem;height:4.5rem;object-fit:contain;flex:none}
.sy-brand h2{margin:0;font-size:var(--fs-xl)}
.sy-brand p{margin:.25rem 0 0;color:var(--c-muted)}
.sy-env{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:var(--gap)}
.sy-env .row{border:0}
.sy-path{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--fs-sm)}
@container (max-width:60rem){.sy-top,.sy-grid{grid-template-columns:minmax(0,1fr)}}
`;

export const SYSTEM_JS = `
const formatBytes = (n) => { const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return n.toFixed(i > 1 ? 1 : 0) + " " + u[i]; };
const formatUptime = (s) => { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return (d ? d + "d " : "") + (d || h ? h + "h " : "") + m + "m"; };

async function renderSystem(view) {
  const body = UI.el("div", { className: "stack" });
  view.replaceChildren(body);

  function draw(d) {
    const s = d.server;
    const facts = (rows) => UI.el("div", {}, ...rows.map(([icon, title, aside]) => UI.row({ icon, title, aside })));
    const identity = UI.card({ children: [UI.el("div", { className: "sy-top" },
      UI.el("div", { className: "sy-brand" }, UI.el("img", { src: "/admin/assets/reach-logo.png", alt: "" }), UI.el("div", {}, UI.el("h2", { textContent: "REACH MCP Server" }), UI.el("p", { textContent: "Self-hosted MCP server for project orchestration and access control." }))),
      facts([["layers", "Version", s.build], ["box", "Commit", s.commit ? s.commit.slice(0, 7) : "Not exposed"], ["clock", "Uptime", formatUptime(s.uptime_seconds)], ["check-circle", "Configuration", s.config_active ? "Active" : "Setup mode"]]))] });

    const storage = UI.card({ icon: "folder", title: "Storage", subtitle: "Directories the Server was configured with", children: d.storage.length
      ? d.storage.map((x) => { const used = x.total_bytes - x.free_bytes, pct = x.total_bytes ? (used / x.total_bytes) * 100 : 0;
          return UI.el("div", { className: "stack" }, UI.row({ icon: "database", title: x.name, detail: x.path, aside: formatBytes(used) + " / " + formatBytes(x.total_bytes) + " (" + pct.toFixed(1) + "%)" }), UI.meter(pct, pct > 90 ? "bad" : pct > 75 ? "warn" : undefined)); })
      : [UI.unavailable("No storage directory is configured")] });
    const tunnel = UI.card({ icon: "tunnel", title: "OpenAI Tunnel", subtitle: "Connection to OpenAI (ChatGPT / Assistants)", children: [UI.unavailable("Not exposed by the Server: the tunnel runs as a separate deployment container")] });
    const services = UI.card({ icon: "pulse", title: "Runtime (Services)", subtitle: "Health of the core server services", children: [
      UI.row({ icon: "code", tone: d.services.http ? "ok" : "warn", title: "API (HTTP)", aside: d.services.http ? UI.pill("Healthy", "ok", "check") : UI.pill("Degraded", "warn") }),
      UI.row({ icon: "wifi", tone: d.services.websocket ? "ok" : "warn", title: "WebSocket (Clients)", aside: d.services.websocket ? UI.pill(d.services.connected_clients + " connected", "ok", "check") : UI.pill("Not active", "warn") })] });
    const update = UI.card({ icon: "refresh", title: "Automatic Update", subtitle: "Automatic server updates and version management", children: [UI.unavailable("Not implemented in the Server: updates are managed by the deployment")] });
    const env = d.environment;
    const environment = UI.card({ icon: "info", title: "Environment", children: [UI.el("div", { className: "sy-env" },
      UI.row({ icon: "code", title: "Node.js", aside: env.node }), UI.row({ icon: "server", title: "Platform", aside: env.platform }),
      UI.row({ icon: "cog", title: "CPU", aside: env.cpus + " vCPU" }), UI.row({ icon: "database", title: "Memory", aside: formatBytes(env.memory_bytes) }))] });
    body.replaceChildren(identity, UI.el("div", { className: "sy-grid" }, storage, tunnel, services, update), environment);
  }

  async function load() {
    const r = await api("GET", "/admin/api/system");
    if (!r.ok) { say("error", "The Server did not answer"); return; }
    draw(r.json);
  }

  await load();
  every(load);
}
`;
