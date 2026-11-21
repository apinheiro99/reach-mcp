// The public install-discovery surface of the service listener: the root page and the two fixed installer downloads, backed only by the ArtifactSource.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { ClientConnectionRegistry, createHttpServer, createInstallHandler, createReleaseHandler, DirectoryArtifactSource, ProposalStore, ServerConfigStore, type ArtifactSource, type Audit, type AuditEvent } from "../src/index.ts";
import { endpointCatalog } from "../src/endpoint-catalog.ts";

const SH = Buffer.from("#!/bin/sh\necho canonical linux installer\n");
const PS1 = Buffer.from("Write-Output 'canonical windows installer'\r\n");
const BEARER = "mcp-bearer-" + "Kq83Zr20";
const LINUX = (host: string) => `curl -fsSL http://${host}/install.sh | sudo sh -s -- --server-origin http://${host}`;
const WINDOWS = (host: string) => `$env:REACH_SERVER_ORIGIN='http://${host}'; irm http://${host}/install.ps1 | iex`;

/** The page escapes every special character as a numeric entity; this is what a browser shows. */
const shown = (html: string): string => html.replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));

type Options = { sh?: boolean; ps1?: boolean; active?: boolean; source?: ArtifactSource | null };

async function start({ sh = true, ps1 = true, active = true, source }: Options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "reach-install-"));
  const artifacts = path.join(dir, "artifacts");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(artifacts);
  writeFileSync(path.join(artifacts, "manifest.json"), '{"release":{"build_id":"b1"}}');
  writeFileSync(path.join(dir, "secret.txt"), "outside the artifacts directory");
  if (sh) writeFileSync(path.join(artifacts, "install.sh"), SH);
  if (ps1) writeFileSync(path.join(artifacts, "install.ps1"), PS1);
  const config = new ServerConfigStore(path.join(dir, "config.json"));
  const connections = new ClientConnectionRegistry({ config, serverBuild: "srv-a", isBuildCompatible: () => true });
  const proposals = new ProposalStore({ path: path.join(dir, "proposal.json"), config, connections });
  const events: AuditEvent[] = [];
  const audit: Audit = { record: (e) => void events.push(e) };
  const used = source === undefined ? new DirectoryArtifactSource(artifacts) : source ?? undefined;
  const server: Server = createHttpServer({
    config, connections, proposals, serverBuild: "srv-a",
    release: createReleaseHandler({ audit, ...(used ? { artifacts: used } : {}) }),
    install: createInstallHandler({ audit, ...(used ? { artifacts: used } : {}) }),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  if (active) config.applyEdit({ mcp_bearer: BEARER, clients: [] });
  const port = (server.address() as AddressInfo).port;
  // fetch cannot choose the Host header, so requests go through node:http.
  const call = (method: string, url: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path: url, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end();
    });
  const close = async () => {
    connections.stop();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return { call, events, close, port };
}

test("with both installers: the root page shows exactly the two canonical commands for the request's own Host, and the fixed routes return the exact artifact bytes with safe headers", async () => {
  const s = await start();
  const page = await s.call("GET", "/", { host: "reach.example:8787" });
  assert.equal(page.status, 200);
  assert.match(String(page.headers["content-type"]), /^text\/html/);
  assert.deepEqual([page.headers["x-content-type-options"], page.headers["cache-control"]], ["nosniff", "no-store"]);
  const body = page.body.toString();
  assert.deepEqual([...body.matchAll(/<pre>(.*)<\/pre>/g)].map((m) => shown(m[1] as string)), [LINUX("reach.example:8787"), WINDOWS("reach.example:8787")]);
  assert.ok(!/<script|<img|<link|src=|href=/i.test(body), "no script and no external asset");
  const sh = await s.call("GET", "/install.sh");
  const ps1 = await s.call("GET", "/install.ps1?cache=bust");
  assert.deepEqual([sh.status, sh.body.equals(SH), ps1.status, ps1.body.equals(PS1)], [200, true, 200, true]);
  assert.deepEqual([sh.headers["content-type"], ps1.headers["content-type"]], ["text/x-shellscript; charset=utf-8", "text/plain; charset=utf-8"]);
  assert.deepEqual([sh.headers["x-content-type-options"], sh.headers["cache-control"], sh.headers["content-length"]], ["nosniff", "no-store", String(SH.length)]);
  assert.deepEqual(s.events.map((e) => [e.action, e.target]), [["artifact_download", "install.sh"], ["artifact_download", "install.ps1"]], "installer downloads use the same audit as release downloads");
  await s.close();
});

test("truthfulness: a command is advertised only while its installer exists, the missing route is 404, and with none the page says so", async () => {
  for (const [options, linux, windows] of [[{ ps1: false }, true, false], [{ sh: false }, false, true], [{ sh: false, ps1: false }, false, false]] as const) {
    const s = await start(options);
    const body = (await s.call("GET", "/", { host: "h:1" })).body.toString();
    assert.equal(body.includes(LINUX("h:1")), linux);
    assert.equal(shown(body).includes(WINDOWS("h:1")), windows);
    assert.equal(body.includes("No installer is available"), !linux && !windows);
    assert.deepEqual([(await s.call("GET", "/install.sh")).status, (await s.call("GET", "/install.ps1")).status], [linux ? 200 : 404, windows ? 200 : 404]);
    await s.close();
  }
  const none = await start({ source: null });
  assert.equal((await none.call("GET", "/")).status, 200, "no artifact directory configured: still a truthful page");
  assert.equal((await none.call("GET", "/install.sh")).status, 404);
  await none.close();
});

test("only GET is served: every other method on the three routes is 405 and serves nothing", async () => {
  const s = await start();
  for (const url of ["/", "/install.sh", "/install.ps1"]) {
    for (const method of ["POST", "PUT", "DELETE", "HEAD", "PATCH"]) assert.equal((await s.call(method, url)).status, 405, `${method} ${url}`);
  }
  assert.equal(s.events.length, 0);
  await s.close();
});

test("unknown and traversal-like paths are 404, never reach the artifact source by another name, and never read outside the artifact directory", async () => {
  const looked: string[] = [];
  const source: ArtifactSource = {
    manifest: () => null,
    artifact: (name) => {
      looked.push(name);
      return name === "install.sh" ? { size: SH.length, stream: () => Readable.from([SH]) } : null;
    },
  };
  const s = await start({ source });
  for (const url of ["/install.sh/", "/install.sh/extra", "/install", "/Install.sh", "/install.sh.bak", "/%2e%2e/secret.txt", "/install.sh%2f..%2fmanifest.json", "/index.html", "//install.sh", "/release"]) {
    assert.equal((await s.call("GET", url)).status, 404, url);
  }
  assert.equal((await s.call("GET", "/install.sh")).body.equals(SH), true, "the bytes come from the injected source");
  assert.ok(looked.every((name) => name === "install.sh" || name === "install.ps1"), `the source is only ever asked for the two fixed names: ${looked.join(",")}`);
  await s.close();
});

test("the Host header is printed only when it is safe, escaped always, and a forwarded host is never used", async () => {
  const s = await start();
  const page = async (headers: Record<string, string>) => (await s.call("GET", "/", headers)).body.toString();
  assert.ok((await page({ host: "[::1]:8787" })).includes(LINUX("[::1]:8787")));
  assert.ok((await page({ host: "10.1.2.3" })).includes(LINUX("10.1.2.3")));
  for (const hostile of ["evil<script>alert(1)</script>", 'a" onmouseover="x', "a b", "a/b", "a|b", "-bad", "a:99999999"]) {
    const html = await page({ host: hostile });
    assert.ok(html.includes(LINUX("&#60;server-address&#62;")) && !html.includes(hostile), `placeholder for ${JSON.stringify(hostile)}`);
  }
  const forwarded = await page({ host: "real.example", "x-forwarded-host": "attacker.example", forwarded: "host=attacker.example" });
  assert.ok(forwarded.includes(LINUX("real.example")) && !forwarded.includes("attacker.example"));
  await s.close();
});

test("discovery needs no active configuration, no bearer and no Admin, and the existing routes are unchanged beside it", async () => {
  const setup = await start({ active: false });
  assert.deepEqual([(await setup.call("GET", "/")).status, (await setup.call("GET", "/install.sh")).status], [200, 200], "setup mode");
  assert.equal((await setup.call("GET", "/health")).status, 503);
  await setup.close();
  const s = await start();
  assert.equal((await s.call("GET", "/health")).status, 401, "health still needs the bearer");
  assert.equal((await s.call("GET", "/health", { authorization: `Bearer ${BEARER}` })).status, 200);
  assert.equal((await s.call("POST", "/mcp")).status, 401, "mcp still needs the bearer");
  assert.equal((await s.call("GET", "/release/manifest")).status, 200);
  assert.equal((await s.call("GET", "/release/artifacts/install.sh")).status, 200, "the release route is untouched");
  assert.equal((await s.call("GET", "/admin/api/state")).status, 404, "no Admin route on the service listener");
  await s.close();
});

test("the endpoint catalog lists the three routes with status taken from the installers' availability, never from calling them", () => {
  const both = endpointCatalog({ configActive: true, artifactsConfigured: true, installers: { sh: true, ps1: true } });
  assert.deepEqual(both.map((e) => `${e.method} ${e.path}`).slice(0, 3), ["GET /", "GET /install.sh", "GET /install.ps1"]);
  assert.deepEqual(both.slice(0, 3).map((e) => e.status), ["healthy", "healthy", "healthy"]);
  const partial = endpointCatalog({ configActive: false, artifactsConfigured: true, installers: { sh: true, ps1: false } });
  assert.deepEqual(partial.slice(0, 3).map((e) => e.status), ["healthy", "healthy", "not_configured"], "root is healthy while its handler exists; a missing installer is not configured");
});
