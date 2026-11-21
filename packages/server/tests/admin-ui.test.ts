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
    assert.ok(!/id: "overview"|label: "Clients"|label: "Projects"/.test(text), `${file} declares a menu entry of its own`);
  }
  for (const [file, text] of Object.entries(uiSource)) if (file !== "shell.ts" && file !== "nav.ts") assert.ok(!text.includes("NAV_ITEMS"), `${file} reads the menu list directly; only the shell may`);
});

const PRIMITIVES = ["card", "pill", "row", "toggle", "field", "input", "btn", "table", "unavailable", "autosave"];

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
  for (const fn of ["icon", "pill", "card", "stat", "row", "toggle", "input", "select", "field", "button", "table", "unavailable", "autosave"]) {
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
  assert.ok(/api\("GET", "\/admin\/api\/state"\)/.test(overview) && /api\("GET", "\/admin\/api\/config"\)/.test(overview), "data comes from the existing endpoints only");
});

test("page: vanilla and self-contained, debounced autosave about 500 ms, no Save button, no framework, remote script or old logo mark", () => {
  const debounce = Number(page.match(/DEBOUNCE_MS = (\d+)/)?.[1]);
  assert.ok(debounce >= 450 && debounce <= 650, "autosave pause is about 500 ms");
  assert.match(page, /setTimeout\(save, DEBOUNCE_MS\)/);
  for (const state of ["editing", "saving", "saved", "error"]) assert.ok(page.includes(`say("${state}"`), `autosave state ${state}`);
  assert.ok(!/>\s*Save\s*</i.test(page) && !/UI\.button\("Save/.test(page), "no generic Save button");
  assert.ok(!/<script[^>]*\ssrc=|<link[^>]*rel="stylesheet"|https?:\/\/(?!www\.w3\.org)/.test(page), "no remote or external resource");
  assert.ok(!/react|vue|svelte|angular|jquery|tailwind|vite/i.test(page));
  assert.ok(!/linked-?loop|link-?loop/i.test(page), "the rejected linked-loop mark is not referenced");
  assert.ok(!page.includes("EventSource"), "no live reload outside DEV");
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
  const later = new Date(Date.now() + 60_000);
  utimesSync(file, later, later);
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(fired, 1, "one change, one restart request");
  utimesSync(file, new Date(Date.now() + 120_000), new Date(Date.now() + 120_000));
  await new Promise((r) => setTimeout(r, 2200));
  assert.equal(fired, 1, "never a second request from the same process");
});
