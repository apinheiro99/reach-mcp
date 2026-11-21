// The one owner of the admin shell: the full-viewport frame, the sidebar built from NAV_ITEMS, the header, the whole-viewport
// network background and the hash router. Views plug into it through VIEWS; they never draw a frame or a menu of their own.
import { NAV_ITEMS } from "./nav.ts";

// A fixed, repeatable constellation (seeded, no randomness at runtime). It is one fixed layer under the whole shell, so it
// shows behind the sidebar, header and content alike; its colors are theme variables and the pulse stops for reduced motion.
function network(): string {
  let seed = 7;
  const next = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const nodes = Array.from({ length: 46 }, () => ({ x: next() * 1000, y: next() * 600 }));
  const lines = nodes.flatMap((a, i) =>
    nodes
      .map((b, j) => ({ j, d: Math.hypot(a.x - b.x, a.y - b.y) }))
      .filter((n) => n.j > i)
      .sort((p, q) => p.d - q.d)
      .slice(0, 2)
      .filter((n) => n.d < 190)
      .map((n) => `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${nodes[n.j]!.x.toFixed(1)}" y2="${nodes[n.j]!.y.toFixed(1)}"/>`),
  );
  const dots = nodes.map((n, i) => `<circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${i % 5 === 0 ? 3 : 1.6}" class="${i % 5 === 0 ? "node" : "star"}"/>`);
  return `<svg class="network" viewBox="0 0 1000 600" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><g class="lines">${lines.join("")}</g><g>${dots.join("")}</g></svg>`;
}

export const SHELL_CSS = `
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;min-height:100vh;background:var(--c-bg);color:var(--c-text);font-family:var(--font);font-size:var(--fs-md)}
.network{position:fixed;inset:0;width:100vw;height:100vh;z-index:0;pointer-events:none}
.network .lines line{stroke:var(--c-line);stroke-width:1}
.network .node{fill:var(--c-node);animation:pulse 6s ease-in-out infinite}
.network .star{fill:var(--c-star);opacity:.6}
.glow{position:fixed;inset:0;z-index:0;pointer-events:none;background:radial-gradient(60vw 40vh at 55% -5%,var(--c-accent-soft),transparent 70%)}
@keyframes pulse{0%,100%{opacity:.45}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.network .node{animation:none}*{transition:none!important}}
.shell{position:relative;z-index:1;display:grid;grid-template-columns:var(--sidebar-w) minmax(0,1fr);width:100vw;min-height:100vh}
.sidebar{display:flex;flex-direction:column;gap:var(--sp-4);padding:var(--sp-4) var(--sp-3);background:var(--c-overlay);border-right:1px solid var(--c-border);position:sticky;top:0;height:100vh}
.brand{display:flex;align-items:center;gap:var(--sp-3);padding:var(--sp-1) var(--sp-2) var(--sp-3)}
.brand img{width:2.6rem;height:2.6rem;object-fit:contain;flex:none}
.brand-name{font-size:1.5rem;font-weight:800;letter-spacing:.02em;line-height:1}
.brand-name span{display:block;color:var(--c-accent);font-size:1.15rem;margin-top:.1rem}
.nav{display:flex;flex-direction:column;gap:var(--sp-1)}
.nav a{display:flex;align-items:center;gap:var(--sp-3);padding:.7rem var(--sp-3);border-radius:var(--radius-control);color:var(--c-text);text-decoration:none;font-weight:500}
.nav a .icon{color:var(--c-muted)}
.nav a:hover{background:var(--c-accent-soft)}
.nav a[aria-current="page"]{background:var(--c-accent);color:var(--c-accent-contrast);font-weight:700}
.nav a[aria-current="page"] .icon{color:var(--c-accent-contrast)}
.version{margin-top:auto;display:flex;align-items:center;gap:var(--sp-3);padding:var(--sp-3) var(--sp-2);color:var(--c-muted);font-size:var(--fs-sm);line-height:1.35}
.version .dot{width:.7rem;height:.7rem;border-radius:50%;background:var(--c-muted);flex:none}
.version[data-state="ok"] .dot{background:var(--c-ok)}
.version strong{display:block;color:var(--c-text);font-weight:600}
.main{display:flex;flex-direction:column;min-width:0;min-height:100vh;padding:0 var(--gutter) var(--gutter)}
.header{display:flex;align-items:center;gap:var(--sp-4);min-height:var(--header-h);border-bottom:1px solid var(--c-border);margin-bottom:var(--gap)}
.header>.icon{width:2.4rem;height:2.4rem;color:var(--c-accent);flex:none}
.header h1{margin:0;font-size:var(--fs-xl);font-weight:700;line-height:1.1}
.header p{margin:.2rem 0 0;color:var(--c-muted);font-size:var(--fs-md)}
.header-end{margin-left:auto;display:flex;align-items:center;gap:var(--sp-4)}
.admin-user{display:flex;align-items:center;gap:var(--sp-2);padding-left:var(--sp-4);border-left:1px solid var(--c-border);font-weight:600}
.admin-user .icon{color:var(--c-accent)}
.view{container-type:inline-size;display:flex;flex-direction:column;gap:var(--gap);min-width:0;flex:1}
.view-banner{padding:var(--sp-3) var(--sp-4);border:1px solid var(--c-accent);border-radius:var(--radius-card);background:var(--c-accent-soft)}
@media (max-width:52rem){.shell{grid-template-columns:minmax(0,1fr)}.sidebar{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center}.nav{flex-direction:row;flex-wrap:wrap}.version{margin-top:0}}
`;

export const SHELL_BACKGROUND_HTML = `<div class="glow" aria-hidden="true"></div>${network()}`;

export const SHELL_HTML = `<div class="shell">
<aside class="sidebar"><div class="brand"><img src="/admin/assets/reach-logo.png" alt="REACH"><div class="brand-name">REACH<span>MCP</span></div></div>
<nav class="nav" id="nav" aria-label="Main"></nav>
<div class="version" id="version"><span class="dot"></span><div><strong>REACH MCP</strong><span id="version-text">…</span></div></div></aside>
<div class="main"><header class="header" id="header"></header><main class="view" id="view"></main></div></div>`;

// The router and shell behaviour. NAV is the one menu list, injected from nav.ts; VIEWS is filled by the views.
export const shellJs = (): string => `
const NAV = ${JSON.stringify(NAV_ITEMS)};
const VIEWS = {};
const autosave = UI.autosave();
const say = (state, text) => autosave.set(state, text);
const clock = () => new Date().toLocaleTimeString([], { hour12: false });
function buildNav() {
  document.getElementById("nav").replaceChildren(...NAV.map((n) => UI.el("a", { href: "#/" + n.id, id: "nav-" + n.id }, UI.icon(n.icon), n.label)));
}
function buildHeader(item) {
  document.getElementById("header").replaceChildren(UI.icon(item.icon), UI.el("div", {}, UI.el("h1", { textContent: item.label }), UI.el("p", { textContent: item.subtitle })),
    UI.el("div", { className: "header-end" }, autosave.el, UI.el("div", { className: "admin-user" }, UI.icon("user"), "admin")));
}
function currentItem() { const id = location.hash.replace("#/", ""); return NAV.find((n) => n.id === id) || NAV[0]; }
let poller = null;
const every = (fn) => { clearInterval(poller); poller = setInterval(fn, 5000); };
async function route() {
  clearInterval(poller);
  const item = currentItem();
  for (const a of document.querySelectorAll("#nav a")) { if (a.id === "nav-" + item.id) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); }
  buildHeader(item);
  const view = document.getElementById("view");
  view.replaceChildren();
  await VIEWS[item.id](view, item);
}
`;
