// The canonical component library of the admin UI, one implementation per primitive: Card, Pill, Row, Toggle, Input/Field, Button,
// Table, Unavailable state and the Autosave indicator. Pages never style these themselves; they call UI.* and pass a tone or
// variant. Change the shape of the pill here and every pill of every screen changes. Colors come from theme.ts, geometry from
// design.ts, so this file carries no color literal.
export const COMPONENT_CSS = `
.card{background:var(--c-card);border:1px solid var(--c-border);border-radius:var(--radius-card);box-shadow:var(--shadow-card);backdrop-filter:blur(6px);min-width:0;display:flex;flex-direction:column}
.card:hover{border-color:var(--c-border-strong)}
.card-head{display:flex;align-items:center;gap:var(--sp-3);padding:var(--sp-4) var(--sp-4) var(--sp-3);border-bottom:1px solid var(--c-border)}
.card-head .icon{color:var(--c-accent);flex:none}
.card-title{margin:0;font-size:var(--fs-lg);font-weight:600;line-height:1.2}
.card-sub{margin:.15rem 0 0;color:var(--c-muted);font-size:var(--fs-sm)}
.card-body{padding:var(--sp-4);display:flex;flex-direction:column;gap:var(--sp-3);flex:1;min-width:0}
.card[data-variant="stat"]{flex-direction:row;align-items:center;gap:var(--sp-4);padding:0 var(--sp-4);min-height:var(--stat-h)}
.card[data-variant="stat"] .icon{color:var(--c-muted);flex:none}
.card[data-variant="stat"][data-tone="ok"] .icon{color:var(--c-ok)}
.card[data-variant="stat"][data-tone="warn"] .icon{color:var(--c-warn)}
.card[data-variant="stat"][data-tone="bad"] .icon{color:var(--c-bad)}
.card[data-variant="stat"][data-tone="accent"] .icon{color:var(--c-accent)}
.stat-value{font-size:var(--fs-num);font-weight:600;line-height:1}
.stat-label{color:var(--c-muted);font-size:var(--fs-md);margin-top:var(--sp-1)}
.icon{width:1.5rem;height:1.5rem;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.pill{display:inline-flex;align-items:center;gap:.35rem;padding:.2rem .65rem;border-radius:var(--radius-pill);border:1px solid var(--c-border-strong);background:transparent;color:var(--c-muted);font-size:var(--fs-sm);font-weight:600;white-space:nowrap}
.pill .icon{width:1rem;height:1rem}
.pill[data-tone="ok"]{color:var(--c-ok);border-color:var(--c-ok);background:var(--c-ok-soft)}
.pill[data-tone="warn"]{color:var(--c-warn);border-color:var(--c-warn);background:var(--c-warn-soft)}
.pill[data-tone="bad"]{color:var(--c-bad);border-color:var(--c-bad);background:var(--c-bad-soft)}
.pill[data-tone="accent"]{color:var(--c-accent);border-color:var(--c-accent);background:var(--c-accent-soft)}
.row{display:flex;align-items:center;gap:var(--sp-3);padding:var(--sp-2) 0;border-bottom:1px solid var(--c-border);min-width:0}
.row:last-child{border-bottom:0}
.row .icon{flex:none;color:var(--c-muted)}
.row[data-tone="ok"] .icon{color:var(--c-ok)}.row[data-tone="warn"] .icon{color:var(--c-warn)}.row[data-tone="bad"] .icon{color:var(--c-bad)}
.row-main{flex:1;min-width:0}
.row-title{font-weight:600;font-size:var(--fs-md);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row-detail{color:var(--c-muted);font-size:var(--fs-sm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row-aside{color:var(--c-muted);font-size:var(--fs-sm);white-space:nowrap}
.toggle{display:inline-flex;align-items:center;gap:var(--sp-2);cursor:pointer;font-size:var(--fs-md)}
.toggle input{appearance:none;width:2.25rem;height:1.25rem;border-radius:var(--radius-pill);background:var(--c-bad-soft);border:1px solid var(--c-bad);position:relative;margin:0;cursor:pointer;transition:background .15s}
.toggle input::after{content:"";position:absolute;top:2px;left:2px;width:.95rem;height:.95rem;border-radius:50%;background:var(--c-bad);transition:transform .15s,background .15s}
.toggle input:checked{background:var(--c-ok-soft);border-color:var(--c-ok)}
.toggle input:checked::after{transform:translateX(1rem);background:var(--c-ok)}
.field{display:flex;flex-direction:column;gap:var(--sp-1);font-size:var(--fs-sm);color:var(--c-muted);min-width:0}
.input{font:inherit;color:var(--c-text);background:var(--c-surface);border:1px solid var(--c-border-strong);border-radius:var(--radius-control);padding:.45rem .65rem;min-width:0;width:100%}
.input[data-kind="path"]{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--fs-sm)}
.input::placeholder{color:var(--c-muted)}
.btn{display:inline-flex;align-items:center;gap:var(--sp-2);font:inherit;font-weight:600;cursor:pointer;color:var(--c-text);background:var(--c-elevated);border:1px solid var(--c-border-strong);border-radius:var(--radius-control);padding:.45rem .9rem}
.btn:hover{border-color:var(--c-accent)}
.btn[data-variant="primary"]{background:var(--c-accent);color:var(--c-accent-contrast);border-color:var(--c-accent)}
.btn[data-variant="primary"]:hover{background:var(--c-accent-hover)}
.btn[data-variant="danger"]{color:var(--c-bad);border-color:var(--c-bad)}
.btn .icon{width:1.1rem;height:1.1rem}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn:disabled:hover{border-color:var(--c-border-strong)}
.icon-btn{display:inline-grid;place-items:center;padding:.25rem;background:transparent;border:0;border-radius:var(--radius-control);color:var(--c-muted);cursor:pointer}
.icon-btn:hover{color:var(--c-accent)}
.icon-btn .icon{width:1.1rem;height:1.1rem}
.card[data-variant="inset"]{background:var(--c-surface);box-shadow:none;backdrop-filter:none}
.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:var(--sp-3)}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--sp-3)}
.stack{display:flex;flex-direction:column;gap:var(--gap)}
.hint{color:var(--c-muted);font-size:var(--fs-sm)}
.table{width:100%;border-collapse:collapse;font-size:var(--fs-sm)}
.table th{color:var(--c-muted);font-weight:600;text-align:left;padding:var(--sp-2);border-bottom:1px solid var(--c-border);position:sticky;top:0;z-index:1;background:var(--c-surface)}
.table td{padding:var(--sp-2);border-bottom:1px solid var(--c-border);overflow-wrap:anywhere}
.card[data-variant="table"] .card-body{padding:0;overflow:auto;max-height:70vh}
.card[data-variant="table"] .table th{padding:var(--sp-4);font-size:var(--fs-md);color:var(--c-text)}
.card[data-variant="table"] .table td{padding:var(--sp-3) var(--sp-4)}
.table tr:last-child td{border-bottom:0}
.table tr[data-tone="warn"] td{background:var(--c-warn-soft);border-bottom-color:transparent}
.table tr[data-tone="warn"] td:first-child{box-shadow:inset 2px 0 0 var(--c-warn)}
.table tr[data-note="head"] td{border-bottom:0}
.table tr[data-note="body"] td{padding-top:0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:var(--gap)}
.toolbar{display:flex;flex-wrap:wrap;align-items:stretch;gap:var(--gap)}
.toolbar>.search{flex:1 1 16rem}
.toolbar .input{height:2.9rem;border-radius:var(--radius-card)}
.toolbar select.input{width:auto;min-width:12rem;flex:none}
.search{position:relative;display:flex;align-items:center;min-width:0}
.search .icon{position:absolute;left:var(--sp-3);width:1.2rem;height:1.2rem;color:var(--c-muted);pointer-events:none}
.search .input{padding-left:2.6rem}
.identity{display:flex;align-items:center;gap:var(--sp-3);min-width:0}
.identity-badge{display:grid;place-items:center;width:2.6rem;height:2.6rem;flex:none;border-radius:var(--radius-control);background:var(--c-elevated);border:1px solid var(--c-border)}
.identity-badge .icon{color:var(--c-accent)}
.identity-badge img{width:70%;height:70%;object-fit:contain}
.identity-title{font-weight:700;font-size:var(--fs-md)}
.identity-sub{color:var(--c-muted);font-size:var(--fs-sm)}
.meter{height:.6rem;border-radius:var(--radius-pill);background:var(--c-border);overflow:hidden}
.meter span{display:block;height:100%;border-radius:var(--radius-pill);background:var(--c-accent)}
.meter[data-tone="warn"] span{background:var(--c-warn)}.meter[data-tone="bad"] span{background:var(--c-bad)}
.unavailable{display:flex;align-items:center;gap:var(--sp-2);color:var(--c-muted);font-size:var(--fs-sm);padding:var(--sp-2) 0}
.unavailable .icon{width:1rem;height:1rem}
.autosave{display:inline-flex;align-items:center;gap:var(--sp-2);padding:.4rem .9rem;border-radius:var(--radius-pill);border:1px solid var(--c-border-strong);background:var(--c-card);font-size:var(--fs-md);white-space:nowrap}
.autosave .dot{width:.6rem;height:.6rem;border-radius:50%;background:var(--c-ok)}
.autosave[data-state="editing"] .dot,.autosave[data-state="saving"] .dot{background:var(--c-warn)}
.autosave[data-state="error"] .dot{background:var(--c-bad)}
.drawer-scrim{position:fixed;inset:0;background:var(--c-scrim);z-index:40}
.drawer{position:fixed;top:0;right:0;bottom:0;width:min(46rem,100vw);background:var(--c-surface);border-left:1px solid var(--c-border-strong);display:flex;flex-direction:column;z-index:41}
.drawer-head{display:flex;align-items:center;gap:var(--sp-3);padding:var(--sp-4);border-bottom:1px solid var(--c-border)}
.drawer-head>div:not(.identity-badge){flex:1;min-width:0}
.drawer-body{flex:1;overflow-y:auto;padding:var(--sp-4);display:flex;flex-direction:column;gap:var(--sp-4)}
.drawer-head .identity-badge{width:3.2rem;height:3.2rem}
.tabs{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:var(--sp-2);padding:var(--sp-1);border:1px solid var(--c-border);border-radius:var(--radius-card)}
.tab{display:inline-flex;align-items:center;justify-content:center;gap:var(--sp-2);font:inherit;font-weight:600;cursor:pointer;color:var(--c-muted);background:transparent;border:1px solid transparent;border-radius:var(--radius-control);padding:.6rem var(--sp-3)}
.tab .icon{width:1.1rem;height:1.1rem}
.tab[aria-selected="true"]{color:var(--c-accent);background:var(--c-accent-soft);border-color:var(--c-accent)}
.btn[data-variant="accent"]{color:var(--c-accent);border-color:var(--c-accent);background:transparent}
.input[data-tone="ok"]{color:var(--c-ok);border-color:var(--c-ok);background:var(--c-ok-soft)}
.input[data-tone="bad"]{color:var(--c-bad);border-color:var(--c-bad);background:var(--c-bad-soft)}
.info-list{margin:0;padding-left:var(--sp-5);color:var(--c-muted);font-size:var(--fs-sm);display:flex;flex-direction:column;gap:var(--sp-1)}
.rule-path{position:relative;display:flex;align-items:center;min-width:10rem}
.rule-path .icon{position:absolute;left:var(--sp-3);width:1.1rem;height:1.1rem;color:var(--c-accent);pointer-events:none}
.rule-path .input{padding-left:2.4rem}
.json-view{margin:0;padding:var(--sp-3);border:1px solid var(--c-border);border-radius:var(--radius-control);background:var(--c-elevated);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--fs-sm);overflow:auto;white-space:pre-wrap}
.drawer-foot{display:flex;justify-content:flex-end;gap:var(--sp-3);padding:var(--sp-4);border-top:1px solid var(--c-border)}
:where(a,button,input,select,summary):focus-visible{outline:none;box-shadow:var(--focus-ring)}
`;

// Browser side of the same owner. Plain script, no framework. The icon set is closed: a view asks for a name from this map.
export const COMPONENT_JS = `
const ICONS = {
  home: "M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10",
  users: "M9 11a3 3 0 100-6 3 3 0 000 6zM3 20v-1a5 5 0 0110 0v1M17 11a2.5 2.5 0 100-5M16 14.2A4.5 4.5 0 0121 19v1",
  layers: "M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5",
  cog: "M12 15a3 3 0 100-6 3 3 0 000 6zM19 12a7 7 0 00-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 00-2-1.2L14.2 3h-4l-.4 2.7a7 7 0 00-2 1.2l-2.3-1-2 3.4 2 1.5a7 7 0 000 2.4l-2 1.5 2 3.4 2.3-1a7 7 0 002 1.2l.4 2.7h4l.4-2.7a7 7 0 002-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z",
  code: "M8 8l-5 4 5 4M16 8l5 4-5 4M14 5l-4 14",
  file: "M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7",
  check: "M5 12.5l4.5 4.5L19 7.5",
  "check-circle": "M12 21a9 9 0 100-18 9 9 0 000 18zM8 12.5l3 3 5-6",
  clock: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2",
  ban: "M12 21a9 9 0 100-18 9 9 0 000 18zM5.6 5.6l12.8 12.8",
  wifi: "M2 9a15 15 0 0120 0M5 12.5a10.5 10.5 0 0114 0M8.5 16a5.5 5.5 0 017 0M12 19.5h.01",
  "wifi-off": "M2 9a15 15 0 013-2.2M8.5 5.4A15 15 0 0122 9M5 12.5a10.5 10.5 0 013-2M11 9.1A10.5 10.5 0 0119 12.5M8.5 16a5.5 5.5 0 013.4-1.5M3 3l18 18M12 19.5h.01",
  pulse: "M3 12h4l3-8 4 16 3-8h4",
  server: "M4 5h16v5H4zM4 14h16v5H4zM8 7.5h.01M8 16.5h.01",
  tunnel: "M12 4a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM5.5 15a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM18.5 15a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM11 9l-4 6M13 9l4 6M8 17.5h8",
  folder: "M3 6h6l2 2h10v11H3z",
  bolt: "M13 2L4 14h7l-1 8 9-12h-7z",
  info: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 8h.01",
  user: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21v-1a6 6 0 0112 0v1",
  box: "M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM4 7.5l8 4.5 8-4.5M12 12v9",
  search: "M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4",
  copy: "M9 9h10v11H9zM5 15V4h10",
  plus: "M12 5v14M5 12h14",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  alert: "M12 3l10 18H2L12 3zM12 10v5M12 18h.01",
  database: "M12 5c4.4 0 8-1 8-2.5S16.4 0 12 0 4 1 4 2.5 7.6 5 12 5zM4 2.5v15C4 19 7.6 20 12 20s8-1 8-2.5v-15M4 10c0 1.5 3.6 2.5 8 2.5s8-1 8-2.5",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zM8.5 12l2.5 2.5 4.5-5",
  close: "M6 6l12 12M18 6L6 18",
  refresh: "M20 11a8 8 0 00-14.5-4M4 4v4h4M4 13a8 8 0 0014.5 4M20 20v-4h-4"
};
const UI = {
  el(tag, props, ...kids) { const n = Object.assign(document.createElement(tag), props || {}); n.append(...kids); return n; },
  icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("class", "icon"); svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", ICONS[name]); svg.append(p); return svg;
  },
  pill(text, tone, icon) { const n = UI.el("span", { className: "pill", textContent: text }); if (tone) n.dataset.tone = tone; if (icon) n.prepend(UI.icon(icon)); return n; },
  card({ icon, title, subtitle, variant, tone, children }) {
    const n = UI.el("section", { className: "card" });
    if (variant) n.dataset.variant = variant;
    if (tone) n.dataset.tone = tone;
    if (title) n.append(UI.el("header", { className: "card-head" }, icon ? UI.icon(icon) : "", UI.el("div", {}, UI.el("h2", { className: "card-title", textContent: title }), subtitle ? UI.el("p", { className: "card-sub", textContent: subtitle }) : "")));
    n.append(UI.el("div", { className: "card-body" }, ...(children || [])));
    return n;
  },
  stats(items) { return UI.el("div", { className: "stats" }, ...items); },
  search({ id, placeholder, onInput }) { return UI.el("div", { className: "search" }, UI.icon("search"), UI.input({ id, placeholder, onInput })); },
  toolbar(...kids) { return UI.el("div", { className: "toolbar" }, ...kids); },
  identity({ icon, badgeImageSrc, badgeImageAlt = "", title, subtitle }) {
    const badge = badgeImageSrc ? UI.el("img", { src: badgeImageSrc, alt: badgeImageAlt }) : UI.icon(icon);
    return UI.el("div", { className: "identity" }, UI.el("div", { className: "identity-badge" }, badge),
      UI.el("div", {}, UI.el("div", { className: "identity-title" }, title), subtitle ? UI.el("div", { className: "identity-sub", textContent: subtitle }) : ""));
  },
  meter(percent, tone) { const n = UI.el("div", { className: "meter" }, UI.el("span", { style: "width:" + Math.max(0, Math.min(100, percent)) + "%" })); n.setAttribute("role", "meter"); n.setAttribute("aria-valuenow", String(Math.round(percent))); if (tone) n.dataset.tone = tone; return n; },
  stat({ icon, value, label, tone }) {
    const n = UI.el("section", { className: "card" });
    n.dataset.variant = "stat"; if (tone) n.dataset.tone = tone;
    n.append(UI.icon(icon), UI.el("div", {}, UI.el("div", { className: "stat-value", textContent: String(value) }), UI.el("div", { className: "stat-label", textContent: label })));
    return n;
  },
  row({ icon, tone, title, detail, aside }) {
    const n = UI.el("div", { className: "row" });
    if (tone) n.dataset.tone = tone;
    if (icon) n.append(UI.icon(icon));
    n.append(UI.el("div", { className: "row-main" }, UI.el("div", { className: "row-title", textContent: title }), detail ? UI.el("div", { className: "row-detail", textContent: detail }) : ""));
    if (aside) n.append(typeof aside === "string" ? UI.el("div", { className: "row-aside", textContent: aside }) : aside);
    return n;
  },
  toggle(label, checked, onChange) {
    const input = UI.el("input", { type: "checkbox", checked });
    input.setAttribute("aria-label", label || (checked ? "On" : "Off"));
    input.addEventListener("change", () => onChange(input.checked));
    return UI.el("label", { className: "toggle" }, input, label);
  },
  input({ type, value, placeholder, kind, id, onInput }) {
    const n = UI.el("input", { className: "input", type: type || "text", value: value ?? "", placeholder: placeholder || "" });
    if (kind) n.dataset.kind = kind;
    if (id) n.id = id;
    if (onInput) n.addEventListener("input", () => onInput(n.value));
    return n;
  },
  select(options, value, onChange) {
    const n = UI.el("select", { className: "input" }, ...options.map(([v, text]) => UI.el("option", { value: v, textContent: text })));
    n.value = value;
    n.addEventListener("change", () => onChange(n.value));
    return n;
  },
  field(label, control) { return UI.el("label", { className: "field" }, label, control); },
  button(text, { variant, icon, onClick }) {
    const n = UI.el("button", { className: "btn", type: "button" }, text);
    if (icon) n.prepend(UI.icon(icon));
    if (variant) n.dataset.variant = variant;
    n.addEventListener("click", onClick);
    return n;
  },
  iconButton(icon, label, onClick) {
    const n = UI.el("button", { className: "icon-btn", type: "button", title: label }, UI.icon(icon));
    n.setAttribute("aria-label", label);
    n.addEventListener("click", onClick);
    return n;
  },
  // A row is a list of cells (text or nodes), or { cells, tone, note }: tone highlights the row, note adds a full-width line under it.
  table(headers, rows) {
    const cell = (c) => UI.el("td", {}, c);
    const body = rows.flatMap((r) => {
      const { cells, tone, note } = Array.isArray(r) ? { cells: r } : r;
      const tr = UI.el("tr", {}, ...cells.map(cell));
      if (tone) tr.dataset.tone = tone;
      if (!note) return [tr];
      tr.dataset.note = "head";
      const extra = UI.el("tr", {}, UI.el("td", { colSpan: headers.length }, note));
      if (tone) extra.dataset.tone = tone;
      extra.dataset.note = "body";
      return [tr, extra];
    });
    return UI.el("table", { className: "table" }, UI.el("thead", {}, UI.el("tr", {}, ...headers.map((h) => UI.el("th", { textContent: h })))), UI.el("tbody", {}, ...body));
  },
  // A right-side panel over a scrim: header (title, subtitle, close), scrolling body, footer actions. The caller owns what closing means.
  drawer({ icon, title, subtitle, children, footer, onClose }) {
    const scrim = UI.el("div", { className: "drawer-scrim" });
    const panel = UI.el("aside", { className: "drawer" },
      UI.el("header", { className: "drawer-head" }, UI.el("div", { className: "identity-badge" }, UI.icon(icon || "folder")), UI.el("div", {}, UI.el("h2", { className: "card-title", textContent: title }), subtitle ? UI.el("p", { className: "card-sub", textContent: subtitle }) : ""), UI.iconButton("close", "Close", onClose)),
      UI.el("div", { className: "drawer-body" }, ...children), UI.el("footer", { className: "drawer-foot" }, ...footer));
    panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", title);
    scrim.addEventListener("click", onClose);
    return UI.el("div", {}, scrim, panel);
  },
  // A strip of mutually exclusive views: items are [id, label, icon]; the caller swaps the content on select.
  tabs(items, active, onSelect) {
    const n = UI.el("div", { className: "tabs", role: "tablist" }, ...items.map(([id, label, icon]) => {
      const b = UI.el("button", { className: "tab", type: "button", role: "tab" }, UI.icon(icon), label);
      b.setAttribute("aria-selected", String(id === active));
      b.addEventListener("click", () => onSelect(id));
      return b;
    }));
    return n;
  },
  unavailable(text) { return UI.el("div", { className: "unavailable" }, UI.icon("info"), text || "Not exposed yet"); },
  autosave() {
    const label = UI.el("span", { textContent: "Ready" });
    const n = UI.el("div", { className: "autosave", role: "status" }, UI.el("span", { className: "dot" }), label);
    n.dataset.state = "saved";
    return { el: n, set(state, text) { n.dataset.state = state; label.textContent = text; } };
  }
};
`;
