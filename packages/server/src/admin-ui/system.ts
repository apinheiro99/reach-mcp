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

import { RUNTIME_KNOBS } from "@reach-mcp/shared/runtime-settings";
import { LOG_LEVELS } from "../logging.ts";

/** The knob names, bounds and units the settings card renders; the values themselves come from the Server config at load. */
const KNOB_FACTS = Object.fromEntries(Object.entries(RUNTIME_KNOBS).map(([name, k]) => [name, { min: k.min, max: k.max, unit: k.unit, applies: k.applies }]));

export const SYSTEM_JS = `
const KNOBS = ${JSON.stringify(KNOB_FACTS)};
const LOG_LEVELS = ${JSON.stringify(LOG_LEVELS)};
const formatBytes = (n) => { const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return n.toFixed(i > 1 ? 1 : 0) + " " + u[i]; };
const formatUptime = (s) => { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return (d ? d + "d " : "") + (d || h ? h + "h " : "") + m + "m"; };

// Logging and runtime settings: ordinary fields that autosave through the one config endpoint. The Server validates and applies them live;
// a refusal is shown as it is. The browser sends the Clients it just read back unchanged, so nothing else in the configuration moves.
async function renderSettings(host) {
  const st = { logging: null, runtime: null, timer: 0 };
  async function saveSettings() {
    say("saving", "Saving…");
    const cur = await api("GET", "/admin/api/config");
    if (!cur.ok) { say("error", "The Server did not answer"); return; }
    const clients = cur.json.clients.map((c) => ({ client_id: c.client_id, ...(c.display_name ? { display_name: c.display_name } : {}), enabled: c.enabled, projects: c.projects }));
    const r = await api("PUT", "/admin/api/config", { logging: st.logging, runtime: st.runtime, clients });
    if (!r.ok) { say("error", "Not saved: " + (r.json.problems || ["unexpected error"]).join("; ")); return; }
    say("saved", "Autosaved · " + clock());
  }
  function edited() {
    say("editing", "Editing…");
    clearTimeout(st.timer);
    st.timer = setTimeout(saveSettings, autosaveDebounceMs);
  }
  const numberField = (target, key, label, hint) => UI.field(label, UI.el("div", {}, UI.input({ type: "number", value: String(target[key]), onInput: (v) => { target[key] = v === "" ? 0 : Number(v); edited(); } }), UI.el("div", { className: "hint", textContent: hint })));
  const r = await api("GET", "/admin/api/config");
  if (!r.ok) { host.replaceChildren(UI.unavailable("The Server did not answer")); return; }
  st.logging = { ...r.json.logging };
  st.runtime = { ...r.json.runtime };
  const logging = UI.card({ icon: "file", title: "Logging", subtitle: "Applies to the next line written, no restart. The audit trail ignores the log level.", children: [UI.el("div", { className: "form-grid" },
    UI.field("Log level", UI.select(LOG_LEVELS.map((l) => [l, l]), st.logging.level, (v) => { st.logging.level = v; edited(); })),
    numberField(st.logging, "max_bytes", "Maximum file size (bytes)", "A file that would pass this size continues in the next numbered segment of the day."),
    numberField(st.logging, "retention_days", "Retention (days)", "Every segment of an older date is deleted together."))] });
  const runtime = UI.card({ icon: "cog", title: "Runtime", subtitle: "Timing knobs the Server and the Clients use; changes apply live.", children: [UI.el("div", { className: "form-grid" },
    ...Object.entries(KNOBS).map(([name, k]) => numberField(st.runtime, name, name + " (" + k.unit + ")", k.applies + " · " + k.min + " to " + k.max)))] });
  host.replaceChildren(logging, runtime);
}

async function renderSystem(view) {
  const body = UI.el("div", { className: "stack" });
  const settings = UI.el("div", { className: "stack" });
  view.replaceChildren(body, settings);
  renderSettings(settings);

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
