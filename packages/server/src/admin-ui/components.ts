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
.toggle input{appearance:none;width:2.25rem;height:1.25rem;border-radius:var(--radius-pill);background:var(--c-elevated);border:1px solid var(--c-border-strong);position:relative;margin:0;cursor:pointer;transition:background .15s}
.toggle input::after{content:"";position:absolute;top:2px;left:2px;width:.95rem;height:.95rem;border-radius:50%;background:var(--c-muted);transition:transform .15s,background .15s}
.toggle input:checked{background:var(--c-accent-soft);border-color:var(--c-accent)}
.toggle input:checked::after{transform:translateX(1rem);background:var(--c-accent)}
.field{display:flex;flex-direction:column;gap:var(--sp-1);font-size:var(--fs-sm);color:var(--c-muted);min-width:0}
.input{font:inherit;color:var(--c-text);background:var(--c-surface);border:1px solid var(--c-border-strong);border-radius:var(--radius-control);padding:.45rem .65rem;min-width:0;width:100%}
.input[data-kind="path"]{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:var(--fs-sm)}
.input::placeholder{color:var(--c-muted)}
.btn{font:inherit;font-weight:600;cursor:pointer;color:var(--c-text);background:var(--c-elevated);border:1px solid var(--c-border-strong);border-radius:var(--radius-control);padding:.45rem .9rem}
.btn:hover{border-color:var(--c-accent)}
.btn[data-variant="primary"]{background:var(--c-accent);color:var(--c-accent-contrast);border-color:var(--c-accent)}
.btn[data-variant="primary"]:hover{background:var(--c-accent-hover)}
.btn[data-variant="danger"]{color:var(--c-bad);border-color:var(--c-bad)}
.card[data-variant="inset"]{background:var(--c-surface);box-shadow:none;backdrop-filter:none}
.form-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:var(--sp-3)}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--sp-3)}
.stack{display:flex;flex-direction:column;gap:var(--gap)}
.hint{color:var(--c-muted);font-size:var(--fs-sm)}
.table{width:100%;border-collapse:collapse;font-size:var(--fs-sm)}
.table th{color:var(--c-muted);font-weight:600;text-align:left;padding:var(--sp-2);border-bottom:1px solid var(--c-border)}
.table td{padding:var(--sp-2);border-bottom:1px solid var(--c-border);overflow-wrap:anywhere}
.unavailable{display:flex;align-items:center;gap:var(--sp-2);color:var(--c-muted);font-size:var(--fs-sm);padding:var(--sp-2) 0}
.unavailable .icon{width:1rem;height:1rem}
.autosave{display:inline-flex;align-items:center;gap:var(--sp-2);padding:.4rem .9rem;border-radius:var(--radius-pill);border:1px solid var(--c-border-strong);background:var(--c-card);font-size:var(--fs-md);white-space:nowrap}
.autosave .dot{width:.6rem;height:.6rem;border-radius:50%;background:var(--c-ok)}
.autosave[data-state="editing"] .dot,.autosave[data-state="saving"] .dot{background:var(--c-warn)}
.autosave[data-state="error"] .dot{background:var(--c-bad)}
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
  user: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21v-1a6 6 0 0112 0v1"
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
  button(text, { variant, onClick }) {
    const n = UI.el("button", { className: "btn", type: "button", textContent: text });
    if (variant) n.dataset.variant = variant;
    n.addEventListener("click", onClick);
    return n;
  },
  table(headers, rows) {
    return UI.el("table", { className: "table" }, UI.el("thead", {}, UI.el("tr", {}, ...headers.map((h) => UI.el("th", { textContent: h })))),
      UI.el("tbody", {}, ...rows.map((r) => UI.el("tr", {}, ...r.map((c) => UI.el("td", { textContent: c }))))));
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
