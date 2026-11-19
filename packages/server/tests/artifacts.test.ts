// Unauthenticated, read-only retrieval of the release manifest and Client artifacts through the admin routes of the one listener.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClientConnectionRegistry, createAdminHandler, createHttpServer, DirectoryArtifactSource, ProposalStore, ServerConfigStore, type Audit, type AuditEvent } from "../src/index.ts";
import { MAX_ARTIFACT_BYTES, MAX_MANIFEST_BYTES } from "../src/artifacts.ts";

const MCP_BEARER = "mcp-bearer-" + "Zr58Lk20";
const MANIFEST = Buffer.from('{"opaque":"manifest owned by the release producer","release":"r-1"}');
const CLIENT_BYTES = randomBytes(300_000);
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function start(options: { artifacts?: boolean; active?: boolean } = {}) {
  const { artifacts = true, active = true } = options;
  const dir = mkdtempSync(path.join(tmpdir(), "reach-artifacts-"));
  const source = path.join(dir, "artifacts");
  mkdirSync(source);
  writeFileSync(path.join(source, "manifest.json"), MANIFEST);
  writeFileSync(path.join(source, "reach-client-linux-x64.tar.gz"), CLIENT_BYTES);
  writeFileSync(path.join(source, ".hidden.tar.gz"), "hidden");
  writeFileSync(path.join(dir, "secret.txt"), "outside the artifacts directory");
  symlinkSync(path.join(dir, "secret.txt"), path.join(source, "linked.tar.gz"));
  mkdirSync(path.join(source, "subdir"));
  writeFileSync(path.join(source, "huge.bin"), "");
  truncateSync(path.join(source, "huge.bin"), MAX_ARTIFACT_BYTES + 1); // sparse: no disk is used
  writeFileSync(path.join(source, "empty.bin"), "");
  const file = path.join(dir, "config.json");
  const config = new ServerConfigStore(file);
  const connections = new ClientConnectionRegistry({ config, serverBuild: "srv-a", isBuildCompatible: () => true });
  const proposals = new ProposalStore({ path: path.join(dir, "proposal.json"), config, connections });
  const events: AuditEvent[] = [];
  const audit: Audit = { record: (e) => void events.push(e) };
  const routes = createAdminHandler({ config, connections, proposals, serverBuild: "srv-a", audit, ...(artifacts ? { artifacts: new DirectoryArtifactSource(source) } : {}) });
  const admin = createHttpServer({ config, connections, proposals, serverBuild: "srv-a", routes });
  const data = admin; // one listener serves the data and the admin/release families
  await new Promise<void>((r) => admin.listen(0, "127.0.0.1", () => r()));
  const port = (s: typeof admin) => (s.address() as AddressInfo).port;
  const a = `http://127.0.0.1:${port(admin)}`;
  const d = `http://127.0.0.1:${port(data)}`;
  if (active) config.applyEdit({ mcp_bearer: MCP_BEARER, clients: [] });
  const get = (p: string, authorization: string | null = `Bearer ${MCP_BEARER}`, method = "GET") =>
    fetch(`${a}${p}`, { method, ...(authorization === null ? {} : { headers: { Authorization: authorization } }) });
  const close = async () => {
    connections.stop();
    admin.closeAllConnections();
    await new Promise<void>((r) => admin.close(() => r()));
  };
  return { source, dir, a, d, get, events, close };
}

const MANIFEST_PATH = "/admin/api/release/manifest";
const ARTIFACT_PATH = "/admin/api/release/artifacts/reach-client-linux-x64.tar.gz";

test("the release routes need no credential: no bearer or a wrong bearer never blocks a catalog download", async () => {
  const rt = await start();
  for (const authorization of [null, "Bearer wrong-" + MCP_BEARER, `Basic ${MCP_BEARER}`]) {
    assert.equal((await rt.get(MANIFEST_PATH, authorization)).status, 200, `manifest with ${authorization}`);
    assert.equal((await rt.get(ARTIFACT_PATH, authorization)).status, 200, `artifact with ${authorization}`);
  }
  await rt.close();
});

test("in setup mode (no active configuration) the release routes still serve, and /health still needs the MCP bearer", async () => {
  const rt = await start({ active: false });
  assert.equal((await rt.get(MANIFEST_PATH, null)).status, 200);
  assert.equal((await rt.get(ARTIFACT_PATH, null)).status, 200);
  assert.equal((await fetch(`${rt.d}/health`)).status, 503, "the data plane still fails closed in setup mode");
  await rt.close();
  const active = await start();
  assert.equal((await fetch(`${active.d}/health`)).status, 401);
  await active.close();
});

test("an unauthenticated caller gets the exact manifest bytes and the exact artifact bytes", async () => {
  const rt = await start();
  const manifest = await rt.get(MANIFEST_PATH);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get("content-type"), "application/json");
  assert.equal(manifest.headers.get("content-length"), String(MANIFEST.length));
  assert.equal(manifest.headers.get("x-content-type-options"), "nosniff");
  assert.ok(Buffer.from(await manifest.arrayBuffer()).equals(MANIFEST));
  const artifact = await rt.get(ARTIFACT_PATH);
  assert.equal(artifact.status, 200);
  assert.equal(artifact.headers.get("content-type"), "application/octet-stream");
  assert.equal(artifact.headers.get("content-length"), String(CLIENT_BYTES.length));
  assert.equal(artifact.headers.get("content-disposition"), 'attachment; filename="reach-client-linux-x64.tar.gz"');
  assert.equal(artifact.headers.get("cache-control"), "no-store");
  assert.equal(sha256(Buffer.from(await artifact.arrayBuffer())), sha256(CLIENT_BYTES));
  assert.deepEqual(rt.events, [{ actor: "admin", action: "artifact_download", target: "reach-client-linux-x64.tar.gz", result: "ok" }], "one audit line, no bearer or bytes");
  await rt.close();
});

test("only declared regular files are served: unknown, traversal-shaped, hidden, symlinked, directory, manifest and malformed names are 404", async () => {
  const rt = await start();
  const names = ["does-not-exist", "..%2Fsecret.txt", "%2e%2e%2fsecret.txt", "..%2F..%2Fetc%2Fpasswd", "%2Fetc%2Fpasswd", "..", ".hidden.tar.gz", "linked.tar.gz", "subdir", "manifest.json", "reach-client-linux-x64.tar.gz%00", "%E0%A4%A", "a%5Cb"];
  for (const name of names) {
    const res = await rt.get(`/admin/api/release/artifacts/${name}`);
    assert.equal(res.status, 404, name);
    assert.ok(!(await res.text()).includes("outside the artifacts directory"), name);
  }
  assert.equal((await rt.get("/admin/api/release/artifacts/sub/dir")).status, 404, "a slash never reaches the source");
  assert.equal((await rt.get("/admin/api/release/artifacts/")).status, 404);
  assert.equal(rt.events.length, 0, "nothing served, nothing audited");
  await rt.close();
});

test("the catalog is fixed at construction: a valid file created afterwards is not served, and the path is never built for it", async () => {
  const rt = await start();
  writeFileSync(path.join(rt.source, "late-arrival.tar.gz"), "late");
  assert.equal((await rt.get("/admin/api/release/artifacts/late-arrival.tar.gz")).status, 404, "present on disk, absent from the catalog");
  assert.equal((await rt.get(ARTIFACT_PATH)).status, 200, "a cataloged file is still served");
  const fresh = new DirectoryArtifactSource(rt.source);
  assert.equal(fresh.artifact("late-arrival.tar.gz")?.size, 4, "a source built afterwards declares it");
  assert.equal(fresh.artifact("manifest.json"), null);
  await rt.close();
});

test("explicit bounds: an oversized manifest, an oversized artifact and an empty file are not served", async () => {
  const rt = await start();
  writeFileSync(path.join(rt.source, "manifest.json"), Buffer.alloc(MAX_MANIFEST_BYTES + 1, 0x20));
  assert.equal((await rt.get(MANIFEST_PATH)).status, 404);
  writeFileSync(path.join(rt.source, "manifest.json"), MANIFEST);
  assert.equal((await rt.get(MANIFEST_PATH)).status, 200, "a manifest at the limit-compliant size is served again");
  assert.equal((await rt.get("/admin/api/release/artifacts/huge.bin")).status, 404);
  assert.equal((await rt.get("/admin/api/release/artifacts/empty.bin")).status, 404);
  await rt.close();
});

test("methods other than GET are refused; a Server without an artifacts source answers 404", async () => {
  const rt = await start();
  assert.equal((await rt.get(MANIFEST_PATH, null, "POST")).status, 405);
  assert.equal((await rt.get(ARTIFACT_PATH, null, "DELETE")).status, 405);
  await rt.close();
  const none = await start({ artifacts: false });
  assert.equal((await none.get(MANIFEST_PATH)).status, 404);
  assert.equal((await none.get(ARTIFACT_PATH)).status, 404);
  await none.close();
});

test("the release routes are admin-family routes of the one listener and no MCP code serves artifacts", async () => {
  const rt = await start();
  assert.equal((await fetch(`${rt.d}/release/manifest`, { headers: { Authorization: `Bearer ${MCP_BEARER}` } })).status, 404, "no separate /release family: the paths are unchanged");
  const mcp = readFileSync(path.join(import.meta.dirname, "..", "src", "mcp.ts"), "utf8");
  assert.ok(!/artifact|manifest|download/i.test(mcp), "no MCP tool serves artifacts");
  await rt.close();
});

test("the artifact owner reads paths nowhere else: admin.ts holds no filesystem access and the browser page no release logic", () => {
  const src = path.join(import.meta.dirname, "..", "src");
  const admin = readFileSync(path.join(src, "admin.ts"), "utf8");
  assert.ok(!/node:fs|createReadStream|readdirSync|path\.join/.test(admin), "the route adapter never touches the filesystem");
  assert.ok(!/release|artifact/i.test(readFileSync(path.join(src, "admin-page.ts"), "utf8")), "the browser page has no release or artifact logic");
});
