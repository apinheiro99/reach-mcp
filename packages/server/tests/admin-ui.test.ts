// Regression guards for the admin UI. They are structural and semantic on purpose (regions, classes, tokens, ownership), not pixel
// snapshots: they fail when the menu is duplicated or reordered, when a primitive gets a second implementation, when a color
// escapes the theme owner, or when the Overview loses its reference composition.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClientConnectionRegistry, createAdminHandler, ProposalStore, ServerConfigStore } from "../src/index.ts";
import { renderAdminPage } from "../src/admin-page.ts";
import { NAV_ITEMS } from "../src/admin-ui/nav.ts";
import { REDRAW_JS } from "../src/admin-ui/components.ts";
import { CLIENTS_JS } from "../src/admin-ui/clients.ts";
import { watchSources } from "../src/admin-ui/dev-reload.ts";

const SRC = path.join(import.meta.dirname, "..", "src");
const UI_DIR = path.join(SRC, "admin-ui");
const read = (...p: string[]) => readFileSync(path.join(...p), "utf8");
const uiFiles = readdirSync(UI_DIR).filter((f) => f.endsWith(".ts"));
const uiSource = Object.fromEntries(uiFiles.map((f) => [f, read(UI_DIR, f)]));
const page = renderAdminPage();
const OTHER_THAN = (owner: string) => Object.entries({ ...uiSource, "admin-page.ts": read(SRC, "admin-page.ts") }).filter(([f]) => f !== owner);

async function start(extra: Partial<Parameters<typeof createAdminHandler>[0]> = {}) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "reach-admin-ui-")), "config.json");
  const config = new ServerConfigStore(file);
  const connections = new ClientConnectionRegistry({ config, serverBuild: "srv-a", isBuildCompatible: () => true });
  const proposals = new ProposalStore({ path: path.join(path.dirname(file), "proposal.json"), config, connections });
  const server = createServer(createAdminHandler({ config, connections, proposals, serverBuild: "srv-a", ...extra }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: async () => (connections.stop(), server.closeAllConnections(), await new Promise<void>((r) => server.close(() => r()))) };
}

test("menu: one navigation source, exact order Overview, Clients, Projects, System, API, Logs, consumed only by the shell", () => {
  assert.deepEqual(NAV_ITEMS.map((n) => n.label), ["Overview", "Clients", "Projects", "System", "API", "Logs"]);
  assert.deepEqual(NAV_ITEMS.map((n) => n.id), ["overview", "clients", "projects", "system", "api", "logs"]);
  const injected = page.match(/const NAV = (\[.*\]);/)?.[1];
  assert.ok(injected, "the page receives the menu as one NAV list");
  assert.deepEqual((JSON.parse(injected) as { label: string }[]).map((n) => n.label), NAV_ITEMS.map((n) => n.label), "the page menu is the nav.ts list, same order");
  assert.equal(page.match(/const NAV = /g)?.length, 1, "NAV is declared once");
  assert.equal(page.match(/id="nav"/g)?.length, 1, "one sidebar nav element");
  assert.equal(page.match(/href: "#\//g)?.length, 1, "menu links are produced in exactly one place");
  for (const [file, text] of OTHER_THAN("nav.ts")) {
    assert.ok(!/id: "overview"|label: "[A-Za-z]+", icon: "[a-z]+", subtitle/.test(text), `${file} declares a menu entry of its own`);
  }
  for (const [file, text] of Object.entries(uiSource)) if (file !== "shell.ts" && file !== "nav.ts") assert.ok(!text.includes("NAV_ITEMS"), `${file} reads the menu list directly; only the shell may`);
});

const PRIMITIVES = ["card", "pill", "row", "toggle", "field", "input", "btn", "table", "unavailable", "autosave", "stats", "toolbar", "search", "identity", "meter"];

test("components: every primitive has one CSS owner and one JS builder, and no view styles or builds one by hand", () => {
  const owner = uiSource["components.ts"] as string;
  for (const name of PRIMITIVES) {
    assert.equal(page.match(new RegExp(`(^|\\n|\\})\\.${name}\\{`, "g"))?.length, 1, `.${name} has exactly one base rule in the page`);
    assert.ok(new RegExp(`\\n\\.${name}\\{`).test(owner), `.${name} is defined in components.ts`);
    for (const [file, text] of OTHER_THAN("components.ts")) {
      assert.ok(!new RegExp(`(^|\\n)\\.${name}[\\s{\\[:.,>]`).test(text), `${file} styles .${name}, which components.ts owns`);
      assert.ok(!new RegExp(`className: "${name}[" ]`).test(text), `${file} builds a ${name} by hand instead of calling UI`);
    }
  }
  for (const [file, text] of OTHER_THAN("components.ts")) {
    assert.ok(!/(createElement|UI\.el)\(\s*"(button|input|select|table|textarea)"/.test(text), `${file} creates a raw form control or table; UI.button/input/select/table own that`);
  }
  for (const fn of ["icon", "pill", "card", "stat", "row", "toggle", "input", "select", "field", "button", "table", "unavailable", "autosave", "stats", "search", "toolbar", "identity", "meter"]) {
    assert.equal(owner.match(new RegExp(`\\n  ${fn}\\(`, "g"))?.length, 1, `UI.${fn} is implemented once`);
  }
  assert.ok(/\.pill\{[^}]*border-radius:var\(--radius-pill\)/.test(owner), "the pill shape is one design token, so one change reshapes every pill");
});

test("tokens: colors live only in theme.ts, every variable in use is defined, light is a slot set and not a second component tree", () => {
  for (const [file, text] of Object.entries({ ...uiSource, "admin-page.ts": read(SRC, "admin-page.ts") })) {
    if (file === "theme.ts") continue;
    assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|\b(white|black|red|green|yellow|gold)\b\s*[;}]/.test(text), `${file} carries a color literal; colors belong to theme.ts`);
  }
  const defined = new Set([...page.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]));
  for (const used of new Set([...page.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))) assert.ok(defined.has(used as string), `${used} is used but never defined`);
  const theme = uiSource["theme.ts"] as string;
  const darkSlots = new Set([...(theme.split('[data-theme="light"]')[0] as string).matchAll(/(--c-[a-z-]+):/g)].map((m) => m[1]));
  const lightSlots = new Set([...(theme.split('[data-theme="light"]')[1] as string).matchAll(/(--c-[a-z-]+):/g)].map((m) => m[1]));
  assert.deepEqual([...lightSlots].sort(), [...darkSlots].sort(), "light fills exactly the same semantic slots as dark");
  assert.ok(page.includes('data-theme="dark"'), "dark is the active theme");
});

test("layout: full viewport, Overview composition of six counters, three columns and three broad cards, fluid and responsive", () => {
  assert.match(page, /\.shell\{[^}]*width:100vw;min-height:100vh/);
  assert.ok(!/\.(shell|main|view)\{[^}]*max-width/.test(page), "no centered max-width dashboard");
  assert.ok(!/1672/.test(page), "no fixed reference canvas");
  assert.match(page, /\.ov-stats\{[^}]*repeat\(6,/);
  assert.equal(page.match(/\.ov-mid\{[^}]*grid-template-columns:([^;]*);/)?.[1]?.trim().split(/\s+/).length, 3, "middle row has three columns");
  assert.equal(page.match(/\.ov-bottom\{[^}]*grid-template-columns:([^;]*);/)?.[1]?.trim().split(/\s+/).length, 3, "bottom row has three cards");
  assert.match(page, /@container \(max-width:/);
  assert.match(page, /clamp\(/);
  assert.match(page, /\.sidebar\{[^}]*position:sticky/);
  const overview = uiSource["overview.ts"] as string;
  assert.equal(overview.match(/UI\.stat\(/g)?.length, 6, "six counter cards");
  for (const title of ["Client Status", "Recent Client Activity", "Server Health", "OpenAI Tunnel", "Private Mount", "Latest Actions"]) assert.ok(overview.includes(`title: "${title}"`), `${title} card`);
});

test("background: one fixed network layer covers the whole viewport behind shell and content, and stops for reduced motion", () => {
  assert.match(page, /\.network\{position:fixed;inset:0;width:100vw;height:100vh;z-index:0/);
  assert.ok(page.indexOf('class="network"') < page.indexOf('class="shell"'), "the background is mounted before and under the shell");
  assert.match(page, /\.shell\{position:relative;z-index:1/);
  assert.match(page, /@media \(prefers-reduced-motion:reduce\)\{[^}]*animation:none/);
  assert.ok((page.match(/<circle /g)?.length ?? 0) > 20 && (page.match(/<line /g)?.length ?? 0) > 20, "nodes and connections exist");
});

test("background: the constellation covers the whole viewport height, not just the top (the old y = 600 * u^2.2 put 72% of the nodes in the top third)", () => {
  const nodes = [...page.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)"/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
  assert.ok(nodes.length >= 40, "the existing density is kept");
  assert.ok(nodes.every((n) => n.x >= 0 && n.x <= 1000 && n.y >= 0 && n.y <= 600), "every node is inside the viewBox, none off screen");
  const share = (from: number, to: number) => nodes.filter((n) => n.y >= from && n.y < to).length / nodes.length;
  assert.ok(share(0, 200) >= 0.2 && share(0, 200) <= 0.5, "top third holds a fair share, not most of the nodes");
  assert.ok(share(200, 400) >= 0.2, "middle third has nodes");
  assert.ok(share(400, 601) >= 0.2, "lower third has nodes");
  assert.ok(share(450, 601) >= 0.15, "lower quarter has nodes");
});

test("Overview shows only API facts: what the Server does not expose is an explicit unavailable state", () => {
  const overview = uiSource["overview.ts"] as string;
  assert.equal(overview.match(/UI\.unavailable\(/g)?.length, 5, "failed state request, empty activity list, tunnel, mount and actions");
  assert.ok(/Tunnel status is not exposed/.test(overview) && /Mount status and usage are not exposed/.test(overview) && /action history is not exposed/.test(overview));
  assert.ok(!/Connected|Mounted|142\.6|42 ms|Argus|Prometheus|Tyga/.test(overview), "no mock telemetry from the reference image");
  assert.ok(/api\("GET", "\/admin\/api\/state"\)/.test(overview) && /api\("GET", "\/admin\/api\/clients"\)/.test(overview), "data comes from the Server endpoints only, with one status owner for Clients");
});

test("page: vanilla and self-contained, autosave states, no Save button, no framework, remote script or old logo mark", () => {
  for (const state of ["saving", "saved", "error"]) assert.ok(page.includes(`say("${state}"`), `autosave state ${state}`);
  assert.ok(!/>\s*Save\s*</i.test(page) && !/UI\.button\("Save(?! changes)/.test(page), "no generic Save button");
  assert.ok(!/<script[^>]*\ssrc=|<link[^>]*rel="stylesheet"|https?:\/\/(?!www\.w3\.org)/.test(page), "no remote or external resource");
  assert.ok(!/react|vue|svelte|angular|jquery|tailwind|vite/i.test(page));
  assert.ok(!/linked-?loop|link-?loop/i.test(page), "the rejected linked-loop mark is not referenced");
  assert.ok(!page.includes("EventSource"), "no live reload outside DEV");
});

test("Clients screen: the approved reference as structure: six counters in order, one search, one status filter, the six columns, two unlabeled toggles and one Rotate Key per row, a highlighted Pending row, only canonical components", () => {
  const clients = uiSource["clients.ts"] as string;
  const labels = [...clients.matchAll(/UI\.stat\(\{ icon: "[a-z-]+", value: n\.\w+, label: "(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(labels, ["Total", "Enabled", "Pending", "Disabled", "Online", "Incompatible", "Offline"], "the counters of docs/screens/02_clients.png plus Incompatible, in that order");
  assert.equal(clients.match(/UI\.search\(/g)?.length, 1, "one search field");
  assert.equal(clients.match(/UI\.select\(/g)?.length, 1, "one status filter");
  assert.ok(clients.includes('["Client", "Status", "Public Key (Fingerprint)", "Access", "Auto Update", "Actions"]'), "Status is the one operational column; the administrative Enabled pill column is gone");
  assert.equal(clients.match(/UI\.toggle\(""/g)?.length, 1, "one table toggle builder, with no visible label");
  assert.equal(clients.match(/cellToggle\("Client access"/g)?.length, 1, "one Enable/Disable toggle owner");
  assert.ok(/cells: \[name, conn, fp, access, autoUpdate, UI\.el\("div", \{ className: "cl-actions" \}, update, rotate\)\]/.test(clients), "Access and Auto Update have their own columns; Actions keeps Update Client and Rotate Key");
  assert.equal(clients.match(/UI\.button\("Rotate Key"/g)?.length, 1, "one Rotate Key action");
  assert.ok(/tone: c\.status === "pending" \? "warn"/.test(clients) && /Awaiting approval\./.test(clients), "the Pending row is highlighted and says why");
  assert.ok(/STATE_PILL = \{ online: \["Online", "ok"/.test(clients) && /UI\.pill\(label, tone, icon\)/.test(clients), "status uses the canonical pill");
  assert.ok(/api\("GET", "\/admin\/api\/clients"\)/.test(clients) && /api\("POST", path\)/.test(clients), "the screen only calls the Server lifecycle API");
  assert.ok(!/status === "enabled" \? .*online|has_public_key|enabled:\s*true/.test(clients), "no status or count is computed from raw config in the UI");
  assert.equal(clients.match(/every\(load\)/g)?.length, 1, "automatic refresh reuses the shell's one poller");
  assert.ok(!/setInterval/.test(clients), "no second refresh timer owner");
  assert.equal(clients.match(/setTimeout/g)?.length, 1, "the only timer is the rename autosave debounce");
  assert.ok(page.includes('data-tone="warn"') || page.includes('tr[data-tone="warn"]'), "the table component owns the row highlight");
});

test("logo: served from the approved REACH mark, byte for byte, and referenced by the page", async () => {
  const rt = await start();
  const res = await fetch(`${rt.url}/admin/assets/reach-logo.png`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  const approved = readFileSync(path.join(import.meta.dirname, "..", "..", "..", "docs", "screens", "07_logo_reach.png"));
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(approved), "the served logo is docs/screens/07_logo_reach.png");
  assert.ok(page.includes("/admin/assets/reach-logo.png"));
  assert.equal((await fetch(`${rt.url}/admin/assets/reach-logo.png`, { method: "POST" })).status, 405);
  await rt.close();
});

test("DEV live reload: off by default, and when on the stream carries one instance id that the page compares to reload once", async () => {
  const off = await start();
  assert.equal((await fetch(`${off.url}/admin/api/dev-reload`)).status, 404, "no reload route in the default process");
  assert.ok(!(await (await fetch(`${off.url}/admin`)).text()).includes("EventSource"));
  await off.close();
  const read1 = async (url: string) => {
    const ctl = new AbortController();
    const res = await fetch(`${url}/admin/api/dev-reload`, { signal: ctl.signal });
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const chunk = new TextDecoder().decode((await res.body!.getReader().read()).value);
    ctl.abort();
    return chunk;
  };
  const a = await start({ devLiveReload: true });
  const b = await start({ devLiveReload: true });
  assert.match(await (await fetch(`${a.url}/admin`)).text(), /new EventSource\("\/admin\/api\/dev-reload"\)/);
  const first = await read1(a.url);
  assert.equal(await read1(a.url), first, "the same process always answers the same instance id");
  assert.notEqual(await read1(b.url), first, "a restarted process answers a different instance id, which is what makes the page reload");
  await a.close();
  await b.close();
});

test("admin peers: with a peer policy an outside address gets 403 on every admin route, an allowed one is served", async () => {
  const closed = await start({ allowFrom: () => false });
  for (const p of ["/admin", "/admin/api/state", "/admin/assets/reach-logo.png"]) assert.equal((await fetch(`${closed.url}${p}`)).status, 403, p);
  await closed.close();
  const open = await start({ allowFrom: (peer) => peer === "127.0.0.1" || peer === "::ffff:127.0.0.1" });
  assert.equal((await fetch(`${open.url}/admin`)).status, 200);
  await open.close();
});

test("DEV source watcher: one polling watcher fires once when a source file time changes, which is what a network share needs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "reach-watch-"));
  const file = path.join(dir, "a.ts");
  writeFileSync(file, "x");
  let fired = 0;
  watchSources([dir], () => fired++);
  await new Promise((r) => setTimeout(r, 300)); // the watcher takes its baseline stat asynchronously; change the file only after it
  const later = new Date(Date.now() + 60_000);
  utimesSync(file, later, later);
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(fired, 1, "one change, one restart request");
  utimesSync(file, new Date(Date.now() + 120_000), new Date(Date.now() + 120_000));
  await new Promise((r) => setTimeout(r, 2200));
  assert.equal(fired, 1, "never a second request from the same process");
});

test("identity badge: one primitive renders either an icon or an image, and Client identities use the canonical REACH mark", () => {
  const owner = uiSource["components.ts"] as string;
  assert.ok(/identity\(\{ icon, badgeImageSrc, badgeImageAlt = "", title, subtitle \}\)/.test(owner), "UI.identity takes an optional badge image next to the icon");
  assert.ok(/badgeImageSrc \? UI\.el\("img", \{ src: badgeImageSrc, alt: badgeImageAlt \}\) : UI\.icon\(icon\)/.test(owner), "exactly one badge visual: the image when given, otherwise the icon");
  assert.ok(/\n\.identity-badge img\{/.test(owner), "the image sizing is a generic rule of the primitive");
  assert.ok(!owner.includes("reach-logo.png"), "the generic primitive stays domain-neutral");
  const clients = uiSource["clients.ts"] as string;
  const projects = uiSource["projects.ts"] as string;
  for (const [file, text] of [["clients.ts", clients], ["projects.ts", projects]] as const) {
    assert.ok(/UI\.identity\(\{ badgeImageSrc: "\/admin\/assets\/reach-logo\.png", title: /.test(text), `${file} shows the Client with the canonical REACH mark`);
    assert.ok(!/UI\.identity\(\{ icon: "box"/.test(text), `${file} no longer shows a Client as a generic box`);
  }
  assert.ok(/UI\.stat\(\{ icon: "box", value: all\.length, label: "Projects" \}\)/.test(projects), "the Projects statistic keeps its box icon");
  assert.ok(/STATE_PILL/.test(clients), "the operational state pill stays in clients.ts");
});

test("Clients status: Online, Offline and Incompatible come from the Server's facts; Enabled is the toggle, not a status pill; Incompatible is never Offline", () => {
  const clients = uiSource["clients.ts"] as string;
  assert.ok(/operationalState = \(c\) => \(!c\.online \? "offline" : c\.compatible === false \? "incompatible" : "online"\)/.test(clients), "a live compatible=false session is Incompatible, not Offline and not Online");
  assert.ok(/STATE_PILL = \{ online: \["Online", "ok", "wifi"\], offline: \["Offline", "bad", "wifi-off"\], incompatible: \["Incompatible", "warn", "alert"\] \}/.test(clients), "explicit text with an icon: color is never the only signal");
  assert.ok(!/STATUS_PILL|\["Enabled", "ok", "check"\]/.test(clients), "no administrative Status pill competes with health");
  assert.ok(/state === "incompatible" \? detail\("Build " \+ c\.client_build \+ " is not accepted by this Server \(build " \+ serverBuild/.test(clients), "the reason shows the two builds the Server reported");
  assert.ok(!/client_build\s*[!=]==?\s*serverBuild|serverBuild\s*[!=]==?/.test(clients), "the browser never compares builds");
  assert.ok(/cellToggle\("Client access",[^\n]*c\.status === "enabled", \(on\) => act\(base \+ \(on \? "\/enable" : "\/disable"\)/.test(clients), "authorization is the unlabeled toggle calling enable/disable");
  assert.ok(/toggle\.querySelector\("input"\)\.setAttribute\("aria-label", name\)/.test(clients), "the unlabeled toggle keeps an accessible name");
  assert.ok(/Awaiting approval\./.test(clients) && /tone: c\.status === "pending" \? "warn"/.test(clients), "Pending stays visible as an onboarding note, apart from health");
  for (const filter of ['["online", "Online"]', '["offline", "Offline"]', '["incompatible", "Incompatible"]']) assert.ok(clients.includes(filter), `filter ${filter}`);
});

test("Clients actions: Update Client only when the Server's facts allow it and through the Server endpoint; Rotate Key needs a compatible online Client", () => {
  const clients = uiSource["clients.ts"] as string;
  assert.equal(clients.match(/UI\.button\("Update Client"/g)?.length, 1, "one Update Client action");
  assert.ok(/act\(base \+ "\/update", "Update requested[^"]*"\)/.test(clients), "it calls the Server update endpoint and nothing else");
  assert.ok(/updateBlock = \(c\) => \(!c\.online \?[^;]*c\.update_available === false \?[^;]*c\.update_capable !== true \?[^;]*c\.current_update \? "An update is already in progress"/.test(clients), "online, update_capable and no attempt in flight (a terminal failure allows a retry), each with a truthful reason");
  assert.ok(/update\.disabled = true; update\.title = blocked/.test(clients), "an unavailable update is disabled with its reason");
  assert.ok(/if \(state !== "online"\) \{ rotate\.disabled = true;/.test(clients) && /An incompatible client cannot rotate its key/.test(clients), "an incompatible management-only Client does not offer Rotate Key");
  assert.ok(/restarting: "Restarting: update result pending"/.test(clients) && !/restarting: "Update applied/.test(clients), "restarting is never labeled applied");
  assert.ok(/applied: "Update applied"/.test(clients) && /c\.last_update_result \? detail\(lastUpdateText\(c\.last_update_result, !!c\.current_update\)/.test(clients) && /"Previous update "/.test(clients), "the terminal result renders from the Server's own field, as the previous one while a retry runs");
  assert.ok(!/client_build\s*[!=]==?\s*serverBuild|update_available\s*=[^=]/.test(clients), "the browser compares no build");
  for (const text of ["Update requested\u2026", "Update failed"]) assert.ok(clients.includes(text.replace("\\u2026", "\u2026")), text);
  assert.ok(/api\("POST", path\)/.test(clients) && /r\.json\.problems \|\| \[r\.json\.result/.test(clients), "a Server refusal (409/422) is shown as it is");
});

test("Clients Auto Update: one per-Client toggle on the shared primitive, a narrow PUT that reloads the Server's value, no global control and no browser rollout logic", () => {
  const clients = uiSource["clients.ts"] as string;
  assert.equal(clients.match(/cellToggle\("Auto Update"/g)?.length, 1, "one Auto Update toggle per row");
  assert.ok(/cellToggle\("Auto Update",[^\n]*c\.auto_update === true, \(on\) => saveAutoUpdate\(c\.client_id, on\)\)/.test(clients), "checked from the Server's c.auto_update");
  assert.ok(/api\("PUT", "\/admin\/api\/clients\/" \+ encodeURIComponent\(clientId\) \+ "\/auto-update", \{ auto_update: on \}\)/.test(clients), "the narrow PUT with exactly { auto_update }");
  assert.ok(/async function saveAutoUpdate[\s\S]*?await load\(true\);\s*\}/.test(clients), "success and failure both reload the canonical value");
  assert.ok(!/\/admin\/api\/config/.test(clients), "the Clients screen never rewrites the whole configuration");
  assert.equal(clients.match(/UI\.button\("Update Client"/g)?.length, 1, "manual Update Client stays, unchanged");
  assert.ok(!/update\.disabled = [^;]*auto_update/.test(clients), "Auto Update never disables the manual update");
  assert.ok(!/client_build\s*[!=]==?\s*serverBuild|setInterval|canary/i.test(clients), "no build comparison, polling scheduler or canary in the browser");
  for (const [file, text] of Object.entries(uiSource)) if (file !== "clients.ts") assert.ok(!/Auto Update/.test(text as string), `${file} has no global Auto Update control`);
});

test("shared primitives: sticky table header and semantic toggle live once in components.ts and no view duplicates them", () => {
  const owner = uiSource["components.ts"] as string;
  assert.ok(/\.table th\{[^}]*position:sticky;top:0;z-index:1;background:var\(--c-surface\)\}/.test(owner), "sticky header with an opaque semantic background and a z-index");
  assert.ok(/\.card\[data-variant="table"\] \.card-body\{padding:0;overflow:auto;max-height:70vh\}/.test(owner), "the table card is the scroll container, so the header has something to stick to");
  assert.ok(/\.toggle input\{[^}]*background:var\(--c-bad-soft\);border:1px solid var\(--c-bad\)/.test(owner) && /\.toggle input:checked\{background:var\(--c-ok-soft\);border-color:var\(--c-ok\)\}/.test(owner), "off is bad-toned, on is ok-toned, from theme tokens");
  assert.ok(/input\.setAttribute\("aria-label"/.test(owner), "the toggle always has accessible text");
  for (const [file, text] of Object.entries(uiSource)) {
    if (file === "components.ts") continue;
    assert.ok(!/(th|thead)[^{}]*\{[^}]*position:sticky/.test(text as string), `${file} has no table-header sticky CSS of its own`);
    assert.ok(!/\.toggle\s*\{|\.toggle input/.test(text as string), `${file} has no toggle styling of its own`);
  }
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test((uiSource["clients.ts"] as string).replace(/"\/admin\/[^"]*"/g, "")), "no raw color in the Clients view");
});

test("Clients API: the view carries the Server build and a counts partition that adds up with Incompatible", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "reach-148-"));
  const config = new ServerConfigStore(path.join(dir, "config.json"));
  const connections = new ClientConnectionRegistry({ config, serverBuild: "srv-9", isBuildCompatible: () => true });
  const proposals = new ProposalStore({ path: path.join(dir, "proposal.json"), config, connections });
  const server = createServer(createAdminHandler({ config, connections, proposals, serverBuild: "srv-9" }));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const body = (await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/admin/api/clients`)).json()) as { server_build: string; counts: Record<string, number> };
  assert.equal(body.server_build, "srv-9");
  assert.equal(body.counts.online! + body.counts.incompatible! + body.counts.offline!, body.counts.total, "every Client is exactly one of Online, Incompatible or Offline");
  server.closeAllConnections();
  connections.stop();
  await new Promise<void>((r) => server.close(() => r()));
});

test("shared stats layout fits any number of counters: Clients renders seven cards and .stats has no fixed column count", () => {
  const owner = uiSource["components.ts"] as string;
  const clients = uiSource["clients.ts"] as string;
  assert.equal(clients.match(/UI\.stat\(\{/g)?.length, 7, "Clients renders seven fleet counters");
  assert.ok(/\.stats\{display:grid;grid-template-columns:repeat\(auto-fit,minmax\(9rem,1fr\)\);gap:var\(--gap\)\}/.test(owner), "the shared grid sizes by content, not by a fixed count");
  assert.ok(!/\.stats\{[^}]*repeat\(\d/.test(owner) && !/@container[^{]*\{\.stats/.test(owner), "no fixed six-column rule and no per-width column override");
  assert.ok(!/\.stats\{|\.cl-stats|grid-template-columns/.test(clients), "no Clients-only grid CSS");
});

// A poll must not send a scrolled list back to the top: the shared redraw keeps the scroll container's position.
type Scroller = { scrollTop: number; scrollLeft: number };
const redrawHarness = () => {
  const redraw = new Function(`${REDRAW_JS}; return redrawKeepingScroll;`)() as (host: unknown, ...nodes: unknown[]) => void;
  const host = {
    body: { scrollTop: 0, scrollLeft: 0 } as Scroller | null,
    querySelector() { return this.body; },
    replaceChildren() { this.body = this.body === null ? null : { scrollTop: 0, scrollLeft: 0 }; },
  };
  return { redraw, host };
};

test("a periodic refresh keeps the list position: the table scroll container's scrollTop and scrollLeft survive the redraw", () => {
  const { redraw, host } = redrawHarness();
  host.body!.scrollTop = 420;
  host.body!.scrollLeft = 36;
  const before = host.body;
  redraw(host, "fresh table");
  assert.notEqual(host.body, before, "the container really was rebuilt");
  assert.deepEqual({ top: host.body!.scrollTop, left: host.body!.scrollLeft }, { top: 420, left: 36 });
  host.body = null;
  assert.doesNotThrow(() => redraw(host, "empty state"), "no scroll container yet: nothing to restore");
});

test("Clients and Projects redraw their table through the shared helper, and the refresh interval is untouched", () => {
  for (const file of ["clients.ts", "projects.ts"]) {
    const text = readFileSync(path.join(import.meta.dirname, "..", "src", "admin-ui", file), "utf8");
    assert.match(text, /UI\.redraw\(tableHost, UI\.card\(\{ variant: "table"/, `${file} redraws the table through UI.redraw`);
    assert.doesNotMatch(text, /tableHost\.replaceChildren\(UI\.card/, `${file} no longer rebuilds the table container directly`);
  }
  assert.match(readFileSync(path.join(import.meta.dirname, "..", "src", "admin-ui", "shell.ts"), "utf8"), /setInterval\(\(\) => \{ fn\(\); refreshVersion\(\); \}, 5000\)/);
});

test("Clients rows: the name is the identity, the id stays searchable in a tooltip, Online counts the session from connected_since, Update is off when the Server says current", () => {
  const clients = readFileSync(path.join(import.meta.dirname, "..", "src", "admin-ui", "clients.ts"), "utf8");
  assert.ok(/subtitle: c\.machine_uuid && c\.machine_uuid !== c\.client_id \? "UUID " \+ c\.machine_uuid : ""/.test(clients), "only the Machine UUID, discreetly, when there is one");
  assert.ok(/nameInput\.title = "Client id " \+ c\.client_id/.test(clients), "the id is still one hover away");
  assert.ok(/\[c\.display_name, c\.client_id, c\.machine_uuid, c\.fingerprint\]/.test(clients), "name, id, Machine UUID and fingerprint stay searchable");
  assert.ok(/c\.online \? "Connected · " \+ \(c\.connected_since \? since\(c\.connected_since\)/.test(clients), "Online shows how long the session has lasted");
  assert.ok(/"Last seen " \+ \(c\.last_seen \? ago\(c\.last_seen\)/.test(clients), "Offline shows the last heartbeat");
  assert.ok(/c\.update_available === false \? "Already up to date"/.test(clients), "the Server's fact disables Update");
  assert.ok(!/client_build\s*[!=]==?\s*serverBuild|serverBuild\s*[!=]==?/.test(clients), "the browser still compares no builds");
});

test("Clients Update: the press disables the button at once, an action reloads even with focus in the table, and a poll still leaves a focused control alone", () => {
  const clients = readFileSync(path.join(import.meta.dirname, "..", "src", "admin-ui", "clients.ts"), "utf8");
  assert.ok(/onClick: \(\) => \{ update\.disabled = true;/.test(clients), "the button is disabled the moment it is pressed");
  assert.ok(/about 20 s/.test(clients), "the operator is told how long it takes");
  assert.ok(/await load\(true\);\n {2}\}\n\n {2}async function saveDisplayName/.test(clients), "an action forces its reload, so the Server's update state shows at once");
  assert.ok(/async function load\(force\) \{\n {4}if \(ui\.editing \|\| \(!force && tableHost\.contains\(document\.activeElement\)\)\) return;/.test(clients), "only a poll skips a focused table; typing a name is always protected");
  assert.ok(/every\(load\)/.test(clients), "the poll itself is unchanged");
});

test("Clients table: the unlabeled Access and Auto Update toggles render in their own columns and call the existing routes", async () => {
  type Node = { tag: string; args: unknown[]; kids: Node[]; attrs: Record<string, string>; title?: string; dataset: object; classList: { add(): void }; append(): void; replaceChildren(): void; setAttribute(k: string, v: string): void; querySelector(): Node; contains(): boolean };
  const node = (tag: string, args: unknown[] = [], kids: unknown[] = []): Node => {
    const n: Node = { tag, args, kids: kids as Node[], attrs: {}, dataset: {}, classList: { add() {} }, append() {}, replaceChildren() {}, setAttribute: (k, v) => { n.attrs[k] = v; }, querySelector: () => n.kids[0] as Node, contains: () => false };
    return n;
  };
  let headers: string[] = [];
  let cells: Node[] = [];
  const calls: unknown[][] = [];
  const ui = new Proxy({
    el: (tag: string, _props: unknown, ...kids: unknown[]) => node(tag, [], kids),
    toggle: (...args: unknown[]) => node("toggle", args, [node("input")]),
    button: (...args: unknown[]) => node("button", args),
    table: (h: string[], rows: { cells: Node[] }[]) => { headers = h; cells = (rows[0] as { cells: Node[] }).cells; return node("table"); },
  } as Record<string, unknown>, { get: (t, k: string) => t[k] ?? ((...args: unknown[]) => node(k, args)) });
  const client = { client_id: "c1", status: "enabled", auto_update: false, online: true, fingerprint: "" };
  const api = async (...args: unknown[]) => { calls.push(args); return { ok: true, json: { server_build: "b", counts: {}, clients: [client] } }; };
  const render = new Function("UI", "api", "say", "clock", "ago", "every", "document", `${CLIENTS_JS}; return renderClients;`)(
    ui, api, () => {}, () => "", () => "", () => {}, { activeElement: null }) as (view: unknown) => Promise<void>;
  await render(node("view"));

  assert.deepEqual(headers.slice(3), ["Access", "Auto Update", "Actions"]);
  const toggles = [cells[3], cells[4]].map((cell) => cell!.kids[0] as Node);
  assert.deepEqual(toggles.map((t) => [t.args[0], t.args[1], (t.kids[0] as Node).attrs["aria-label"]]), [["", true, "Client access"], ["", false, "Auto Update"]]);
  assert.deepEqual(cells[5]!.kids.map((k) => k.args[0]), ["Update Client", "Rotate Key"]);
  (toggles[0]!.args[2] as (on: boolean) => void)(false);
  (toggles[1]!.args[2] as (on: boolean) => void)(true);
  assert.deepEqual(calls.filter((c) => c[0] !== "GET"), [["POST", "/admin/api/clients/c1/disable"], ["PUT", "/admin/api/clients/c1/auto-update", { auto_update: true }]]);
});
