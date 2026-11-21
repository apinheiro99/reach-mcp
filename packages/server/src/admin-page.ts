// The admin page: one self-contained document with plain DOM code, no framework, no bundler and no remote script. This file only
// composes the owners in admin-ui/: theme.ts (colors), design.ts (layout), components.ts (the canonical components), nav.ts (the
// one menu), shell.ts (frame, background, router) and one module per view. The server is the authority on validity, the page
// only shows what it answers.
import { API_JS } from "./admin-ui/api-client.ts";
import { CLIENTS_CSS, CLIENTS_JS } from "./admin-ui/clients.ts";
import { COMPONENT_CSS, COMPONENT_JS } from "./admin-ui/components.ts";
import { DESIGN_CSS } from "./admin-ui/design.ts";
import { DEV_RELOAD_SCRIPT } from "./admin-ui/dev-reload.ts";
import { OVERVIEW_CSS, OVERVIEW_JS } from "./admin-ui/overview.ts";
import { SHELL_BACKGROUND_HTML, SHELL_CSS, SHELL_HTML, shellJs } from "./admin-ui/shell.ts";
import { THEME_CSS } from "./admin-ui/theme.ts";

const BOOT_JS = `
VIEWS.overview = async (view) => { await renderOverview(view); every(() => renderOverview(view)); };
VIEWS.clients = renderClients;
for (const item of NAV) if (!VIEWS[item.id]) VIEWS[item.id] = (view, it) => view.replaceChildren(UI.card({ icon: it.icon, title: it.label, children: [UI.unavailable("This screen is built in a later task")] }));
async function refreshVersion() {
  const r = await api("GET", "/admin/api/state");
  if (!r.ok) return;
  const h = r.json.health;
  document.getElementById("version-text").textContent = h.server_build + (h.repository_commit ? " (" + h.repository_commit.slice(0, 7) + ")" : "");
  document.getElementById("version").dataset.state = h.status === "ok" ? "ok" : "";
}
buildNav();
window.addEventListener("hashchange", route);
route().then(() => say("saved", "Ready"));
refreshVersion();
setInterval(refreshVersion, 5000);
`;

export function renderAdminPage(options: { devLiveReload?: boolean; adminUser?: string } = {}): string {
  const script = ['"use strict";', COMPONENT_JS, API_JS, shellJs(options.adminUser), OVERVIEW_JS, CLIENTS_JS, BOOT_JS, options.devLiveReload ? DEV_RELOAD_SCRIPT : ""].join("\n");
  return `<!doctype html>
<html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>REACH Server</title>
<link rel="icon" href="/admin/assets/reach-logo.png">
<style>${THEME_CSS}${DESIGN_CSS}${SHELL_CSS}${COMPONENT_CSS}${OVERVIEW_CSS}${CLIENTS_CSS}</style></head><body>
${SHELL_BACKGROUND_HTML}
${SHELL_HTML}
<script>${script}</script></body></html>`;
}
