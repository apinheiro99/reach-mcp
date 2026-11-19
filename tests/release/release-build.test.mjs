// Release proof: ONE real build, then the produced artifacts are inspected, extracted, run and served. Needs the npm registry
// and takes minutes, so it runs as `npm run check:release` (and the CI "Release Check" job), not inside `npm test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { build } from "../../scripts/release.mjs";
import { collectEntries } from "../../scripts/release/archive.mjs";
import { serverArgs } from "../../deploy/prod/entrypoint.mjs";
import { sha256, validateManifest, verifyRelease } from "../../scripts/release/manifest.mjs";

const { fetch } = globalThis;
const BUILD_ID = "release-test-1";
const COMMIT = "b".repeat(40);
const BEARER = "release-bearer-" + "Zq81Lm40";
let base;
let out;
let manifest;
const names = { linux: "reach-client-linux-x64.tgz", windows: "reach-client-win32-x64.zip", server: "reach-server-linux-x64.tgz" };

const extracted = new Map();
const extract = (kind) => {
  if (extracted.has(kind)) return extracted.get(kind);
  const dir = path.join(base, `x-${kind}`);
  extracted.set(kind, dir);
  mkdirSync(dir);
  if (kind === "windows") execFileSync("unzip", ["-q", path.join(out, "artifacts", names.windows), "-d", dir]);
  else execFileSync("tar", ["-xzf", path.join(out, kind === "server" ? "server" : "artifacts", names[kind]), "-C", dir]);
  return dir;
};
const files = (dir) => collectEntries(dir).map((e) => e.path);

before(() => {
  base = mkdtempSync(path.join(tmpdir(), "reach-release-it-"));
  out = path.join(base, "out");
  build({ buildId: BUILD_ID, repositoryCommit: COMMIT, out });
  manifest = JSON.parse(readFileSync(path.join(out, "artifacts", "manifest.json"), "utf8"));
});
after(() => rmSync(base, { recursive: true, force: true }));

test("one invocation: manifest valid and coherent, exactly the three archives, hashes and sizes equal the final bytes", () => {
  assert.deepEqual(validateManifest(manifest), []);
  assert.deepEqual([manifest.release.build_id, manifest.server.build_id, manifest.client.build_id, manifest.release.repository_commit], [BUILD_ID, BUILD_ID, BUILD_ID, COMMIT]);
  assert.deepEqual(manifest.compatibility, { strategy: "exact", accepted_client_builds: [BUILD_ID] });
  assert.deepEqual(manifest.artifacts.map((a) => a.name).sort(), Object.values(names).sort());
  assert.deepEqual(files(out).sort(), ["artifacts/manifest.json", `artifacts/${names.linux}`, `artifacts/${names.windows}`, `server/${names.server}`].sort());
  assert.deepEqual(verifyRelease(out), []);
});

test("every archive is a self-contained runtime: REACH packages as plain dirs, production dependencies, no link, no Git, no dev or test material", () => {
  const seen = {};
  for (const kind of ["linux", "windows", "server"]) {
    const dir = extract(kind);
    const list = files(dir); // collectEntries throws on any symlink
    seen[kind] = list;
    const top = kind === "server" ? "reach-server" : "reach-client";
    assert.ok(list.includes(`${top}/${top}.mjs`) && list.includes(`${top}/lib/${kind === "server" ? "server" : "client"}/src/main.ts`), `${kind}: launcher and unchanged entrypoint`);
    assert.ok(list.includes(`${top}/lib/shared/src/wire/index.ts`), `${kind}: shared package`);
    assert.ok(list.some((f) => f.startsWith(`${top}/node_modules/ws/`)), `${kind}: production dependency installed`);
    for (const forbidden of [/\.git(\/|$)/, /\/lib\/[^/]+\/(tests?|testing)\//, /\/src\/testing\//, /node_modules\/\.bin/, /node_modules\/(typescript|eslint|@types)\//, /node_modules\/@reach-mcp/, /(^|\/)\.env/, /reach-private/, /\.gitlab-ci/]) {
      assert.ok(!list.some((f) => forbidden.test(f)), `${kind}: ${forbidden}`);
    }
  }
  assert.ok(seen.linux.some((f) => f.includes("lib/git-compat/src/")) && !seen.server.some((f) => f.includes("lib/client/")), "the Client closure has git-compat; the Server has no Client code");
  assert.ok(seen.windows.some((f) => f.includes("canvas-win32-x64-msvc")) && !seen.windows.some((f) => f.includes("canvas-linux-")), "the Windows archive carries only its own native binary");
  assert.ok(seen.linux.some((f) => f.includes("canvas-linux-x64-gnu")) && !seen.linux.some((f) => f.includes("canvas-win32-")), "the Linux archive carries only its own native binary");
  const logical = (list) => list.filter((f) => f.includes("/lib/")).sort();
  assert.deepEqual(logical(seen.linux), logical(seen.windows), "Linux and Windows hold the same logical REACH runtime");
  const zipinfo = execFileSync("unzip", ["-Z", path.join(out, "artifacts", names.windows)], { encoding: "utf8" });
  assert.ok(!/^l/m.test(zipinfo), "no symlink entry in the ZIP");
});

test("extracted artifacts run their own entrypoints without module-resolution failure (no workspace, no repository)", () => {
  for (const [kind, top, usage] of [["linux", "reach-client", "usage: client"], ["windows", "reach-client", "usage: client"], ["server", "reach-server", "usage: server"]]) {
    const dir = path.join(extract(kind), top);
    const run = spawnSync(process.execPath, [`${top}.mjs`], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(run.status, 2, `${kind}: ${run.stderr}`);
    assert.ok(run.stderr.includes(usage) && !/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.test(run.stderr), `${kind}: ${run.stderr}`);
  }
});

test("the real Linux Client archive installs with deploy/client/install-linux.sh into a temporary prefix and runs from there, away from any repository", () => {
  const prefix = mkdtempSync(path.join(base, "prefix-"));
  const install = path.join(prefix, "opt", "reach-mcp-client");
  const units = path.join(prefix, "units");
  const bootstrap = path.join(prefix, "private", "bootstrap.env");
  const script = path.join(import.meta.dirname, "..", "..", "deploy", "client", "install-linux.sh");
  const done = spawnSync("bash", [script, "--archive", path.join(out, "artifacts", names.linux), "--bootstrap", bootstrap, "--build", BUILD_ID, "--install-dir", install, "--unit-dir", units, "--node", process.execPath], { encoding: "utf8" });
  assert.equal(done.status, 0, done.stderr);
  const unit = readFileSync(path.join(units, "reach-mcp-client.service"), "utf8");
  assert.ok(unit.includes(`ExecStart="${process.execPath}" "${install}/reach-client.mjs" --bootstrap "${bootstrap}" --build ${BUILD_ID}\n`) && !/packages\/|allow-insecure-ws/.test(unit), unit);
  const run = spawnSync(process.execPath, [path.join(install, "reach-client.mjs")], { cwd: prefix, encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(run.status, 2, run.stderr);
  assert.ok(run.stderr.includes("usage: client") && !/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/.test(run.stderr), run.stderr);
  const missing = spawnSync(process.execPath, [path.join(install, "reach-client.mjs"), "--bootstrap", bootstrap, "--build", BUILD_ID], { cwd: prefix, encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(missing.status, 2, "a missing bootstrap file is a clean refusal from the installed Client");
});

test("a real Server from the extracted runtime serves the produced manifest and both Client archives; the bytes equal the manifest hashes", async () => {
  const dir = path.join(extract("server"), "reach-server");
  const state = path.join(base, "state");
  const args = ["reach-server.mjs", "--config", `${state}/private/config.json`, "--proposal", `${state}/private/proposal.json`, "--logs", `${state}/logs`, "--port", "0", "--build", BUILD_ID, "--artifacts", path.join(out, "artifacts")];
  const child = spawn(process.execPath, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  try {
    for (let i = 0; i < 100 && !output.includes("listening"); i++) await new Promise((r) => setTimeout(r, 50));
    const port = /port=(\d+)/.exec(output);
    assert.ok(port, output);
    const admin = `http://127.0.0.1:${port[1]}`;
    assert.equal((await fetch(`${admin}/admin/api/config`, { method: "PUT", body: JSON.stringify({ mcp_bearer: BEARER, clients: [] }) })).status, 200);
    const auth = { headers: { Authorization: `Bearer ${BEARER}` } };
    assert.deepEqual(Buffer.from(await (await fetch(`${admin}/admin/api/release/manifest`, auth)).arrayBuffer()), readFileSync(path.join(out, "artifacts", "manifest.json")), "the manifest served is the manifest produced");
    for (const a of manifest.artifacts.filter((x) => x.role === "client")) {
      const res = await fetch(`${admin}/admin/api/release/artifacts/${a.name}`, auth);
      assert.equal(res.status, 200, a.name);
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.deepEqual([bytes.length, sha256(bytes)], [a.size_bytes, a.sha256], a.name);
      assert.deepEqual(bytes, readFileSync(path.join(out, "artifacts", a.name)), "the same bytes the builder produced");
      assert.equal((await fetch(`${admin}/admin/api/release/artifacts/${a.name}`)).status, 200, "no credential needed to download");
    }
    assert.equal((await fetch(`${admin}/admin/api/release/artifacts/${names.server}`, auth)).status, 404, "the Server runtime is not a served artifact");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
  }
});

test("the production entrypoint starts the real extracted Server from the manifest identity; the healthcheck passes in setup mode without a bearer", async () => {
  const state = path.join(base, "prod-state");
  mkdirSync(state, { recursive: true });
  const layout = { server: path.join(extract("server"), "reach-server", "reach-server.mjs"), artifacts: path.join(out, "artifacts"), config: `${state}/config.json`, proposal: `${state}/proposal.json`, logs: `${state}/logs` };
  const args = serverArgs({ REACH_HOST: "127.0.0.1", REACH_PORT: "0" }, layout);
  assert.deepEqual([args[args.indexOf("--build") + 1], args[args.indexOf("--repository-commit") + 1]], [BUILD_ID, COMMIT]);
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH } });
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  try {
    for (let i = 0; i < 100 && !output.includes("listening"); i++) await new Promise((r) => setTimeout(r, 50));
    const port = /port=(\d+)/.exec(output);
    assert.ok(port, output);
    const health = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "..", "deploy", "prod", "healthcheck.mjs")], { env: { PATH: process.env.PATH, REACH_PORT: port[1] } });
    assert.equal(health.status, 0, "healthy in setup mode with no bearer configured");
    const down = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "..", "deploy", "prod", "healthcheck.mjs")], { env: { PATH: process.env.PATH, REACH_PORT: "1" } });
    assert.equal(down.status, 1, "unhealthy when nothing listens");
    const admin = `http://127.0.0.1:${port[1]}`;
    assert.equal((await fetch(`${admin}/admin/api/config`, { method: "PUT", body: JSON.stringify({ mcp_bearer: BEARER, clients: [] }) })).status, 200);
    const auth = { headers: { Authorization: `Bearer ${BEARER}` } };
    for (const a of manifest.artifacts.filter((x) => x.role === "client")) {
      const bytes = Buffer.from(await (await fetch(`${admin}/admin/api/release/artifacts/${a.name}`, auth)).arrayBuffer());
      assert.deepEqual(bytes, readFileSync(path.join(out, "artifacts", a.name)), `${a.name}: the baked bytes are the canonical bytes`);
    }
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => child.once("exit", r));
  }
});

test("can it fail: a corrupted, truncated, missing or undeclared artifact makes verification fail", () => {
  const copy = (name) => {
    const dir = path.join(base, name);
    cpSync(out, dir, { recursive: true });
    return dir;
  };
  const flipped = copy("c-flip");
  const file = path.join(flipped, "artifacts", names.windows);
  const bytes = readFileSync(file);
  bytes[bytes.length >> 1] ^= 0xff;
  writeFileSync(file, bytes);
  assert.match(verifyRelease(flipped).join(), /sha256 differs/);
  const cut = copy("c-cut");
  writeFileSync(path.join(cut, "artifacts", names.linux), readFileSync(path.join(cut, "artifacts", names.linux)).subarray(0, 1000));
  assert.match(verifyRelease(cut).join(), /size 1000 differs/);
  const gone = copy("c-gone");
  rmSync(path.join(gone, "server", names.server));
  assert.match(verifyRelease(gone).join(), /missing/);
  const extra = copy("c-extra");
  writeFileSync(path.join(extra, "artifacts", "stray.bin"), "x");
  assert.match(verifyRelease(extra).join(), /not declared/);
  for (const dropped of [names.windows, names.linux, names.server]) {
    const mutilated = copy(`c-drop-${dropped}`);
    const manifestFile = path.join(mutilated, "artifacts", "manifest.json");
    const edited = JSON.parse(readFileSync(manifestFile, "utf8"));
    edited.artifacts = edited.artifacts.filter((a) => a.name !== dropped);
    writeFileSync(manifestFile, JSON.stringify(edited));
    rmSync(path.join(mutilated, dropped === names.server ? "server" : "artifacts", dropped));
    assert.deepEqual(verifyRelease(mutilated).filter((p) => !/is missing$/.test(p)), [], `${dropped}: only the completeness problem, files and manifest agree`);
    assert.match(verifyRelease(mutilated).join(), /required .* is missing/, `${dropped}: a consistently mutilated release is rejected`);
  }
  const cli = spawnSync(process.execPath, ["scripts/release.mjs", "verify", "--out", flipped], { encoding: "utf8", cwd: path.join(import.meta.dirname, "..", "..") });
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /verification failed/);
});
