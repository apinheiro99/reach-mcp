// Release proof: ONE real build, then the produced artifacts are inspected, extracted, run and served. Needs the npm registry
// and takes minutes, so it runs as `npm run check:release` (and the CI "Release Check" job), not inside `npm test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { build } from "../../scripts/release.mjs";
import { collectEntries } from "../../scripts/release/archive.mjs";
import { serverArgs } from "../../deploy/prod/entrypoint.mjs";
import { selectClient } from "./select-client.mjs";
import { sha256, validateManifest, verifyRelease } from "../../scripts/release/manifest.mjs";

const { fetch } = globalThis;
const BUILD_ID = "release-test-1";
const COMMIT = "b".repeat(40);
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

const START_MS = 5000;
const STOP_MS = 5000;
/** Start a Server child and resolve once it prints "listening"; reject at once, with the captured output, if it exits first or the wait runs out. */
const startServer = (args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    const handle = { child, output: "" };
    const timer = setTimeout(() => settle(new Error(`no "listening" within ${START_MS} ms:\n${handle.output}`)), START_MS);
    const settle = (error) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      if (error) stopChild(child).finally(() => reject(error));
      else resolve(handle);
    };
    const onData = (c) => {
      handle.output += c;
      if (handle.output.includes("listening")) settle();
    };
    const onExit = (code, signal) => settle(new Error(`exited before listening (code=${code} signal=${signal}):\n${handle.output}`));
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
/** Stop a child without ever waiting unbounded: nothing to do if it already exited, SIGTERM, then SIGKILL after STOP_MS. */
const stopChild = (child) =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const kill = setTimeout(() => child.kill("SIGKILL"), STOP_MS);
    child.once("exit", () => {
      clearTimeout(kill);
      resolve();
    });
    child.kill("SIGTERM");
  });

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
  assert.deepEqual(files(out).sort(), ["artifacts/manifest.json", "artifacts/install.sh", "artifacts/install.ps1", `artifacts/${names.linux}`, `artifacts/${names.windows}`, `server/${names.server}`].sort());
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
  const args = ["reach-server.mjs", "--config", `${state}/private/config.json`, "--proposal", `${state}/private/proposal.json`, "--logs", `${state}/logs`, "--port", "0", "--admin-port", "0", "--build", BUILD_ID, "--artifacts", path.join(out, "artifacts")];
  const { child, output } = await startServer(args, { cwd: dir });
  try {
    const port = /listening port=(\d+) admin_port=(\d+)/.exec(output);
    assert.ok(port, output);
    const service = `http://127.0.0.1:${port[1]}`;
    const auth = {};
    assert.deepEqual(Buffer.from(await (await fetch(`${service}/release/manifest`, auth)).arrayBuffer()), readFileSync(path.join(out, "artifacts", "manifest.json")), "the manifest served is the manifest produced");
    for (const [os, arch] of [["linux", "x64"], ["win32", "x64"]]) {
      const a = selectClient(manifest, os, arch);
      assert.equal(a.download_path, `/release/artifacts/${a.name}`);
      const res = await fetch(`${service}${a.download_path}`, auth);
      assert.equal(res.status, 200, a.name);
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.deepEqual([bytes.length, sha256(bytes)], [a.size_bytes, a.sha256], a.name);
      assert.deepEqual(bytes, readFileSync(path.join(out, "artifacts", a.name)), "the same bytes the builder produced");
      assert.equal((await fetch(`${service}/release/artifacts/${a.name}`)).status, 200, "no credential needed to download");
    }
    assert.equal((await fetch(`${service}/release/artifacts/${names.server}`, auth)).status, 404, "the Server runtime is not a served artifact");
  } finally {
    await stopChild(child);
  }
});

test("the production entrypoint starts the real extracted Server from the manifest identity; the healthcheck passes in setup mode without a bearer", async () => {
  const root = path.join(base, "reach-private");
  mkdirSync(root, { recursive: true }); // what the deployment controller does for a first run: an empty private root, no files in it
  const layout = { server: path.join(extract("server"), "reach-server", "reach-server.mjs"), artifacts: path.join(out, "artifacts"), config: `${root}/config.json`, proposal: `${root}/proposal.json`, logs: `${root}/logs` };
  const args = serverArgs({ REACH_HOST: "127.0.0.1", REACH_PORT: "0", REACH_ADMIN_PORT: "0", REACH_ADMIN_ALLOW_FROM: "203.0.113.0/24" }, layout);
  assert.deepEqual([args[args.indexOf("--build") + 1], args[args.indexOf("--repository-commit") + 1]], [BUILD_ID, COMMIT]);
  assert.equal(args[args.indexOf("--admin-allow-from") + 1], "203.0.113.0/24", "the Admin allowlist excludes loopback on purpose: health must not depend on it");
  const { child, output } = await startServer(args, { env: { PATH: process.env.PATH } });
  try {
    const port = /listening port=(\d+) admin_port=(\d+)/.exec(output);
    assert.ok(port, output);
    const health = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "..", "deploy", "prod", "healthcheck.mjs")], { env: { PATH: process.env.PATH, REACH_PORT: port[1] } });
    assert.ok(existsSync(path.join(root, "logs")), "the Server created its log directory inside the private root");
    assert.equal(health.status, 0, "healthy in setup mode with no bearer configured, while the Admin allowlist excludes the probe's loopback address");
    assert.equal((await fetch(`http://127.0.0.1:${port[2]}/admin/api/state`)).status, 403, "the Admin plane really refuses a peer outside the allowlist");
    const down = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "..", "deploy", "prod", "healthcheck.mjs")], { env: { PATH: process.env.PATH, REACH_PORT: "1" } });
    assert.equal(down.status, 1, "unhealthy when nothing listens");
    const service = `http://127.0.0.1:${port[1]}`;
    const auth = {};
    for (const a of manifest.artifacts.filter((x) => x.role === "client")) {
      const bytes = Buffer.from(await (await fetch(`${service}/release/artifacts/${a.name}`, auth)).arrayBuffer());
      assert.deepEqual(bytes, readFileSync(path.join(out, "artifacts", a.name)), `${a.name}: the baked bytes are the canonical bytes`);
    }
  } finally {
    await stopChild(child);
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

test("can it hang: a Server that exits before listening fails at once with its output, and stopping an already exited child returns", async () => {
  const started = Date.now();
  await assert.rejects(startServer(["-e", 'console.error("boom"); process.exit(3)']), /exited before listening \(code=3 signal=null\):\nboom/);
  assert.ok(Date.now() - started < 2000, "early exit does not wait for the startup timeout");
  const exited = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => exited.once("exit", r));
  await stopChild(exited);
});

test("the production entrypoint contract: the Admin listener is non-loopback by default and the Server refuses it without an allowlist", async () => {
  const root = path.join(base, "no-allowlist");
  const layout = { server: path.join(extract("server"), "reach-server", "reach-server.mjs"), artifacts: path.join(out, "artifacts"), config: `${root}/config.json`, proposal: `${root}/proposal.json`, logs: `${root}/logs` };
  const args = serverArgs({ REACH_HOST: "127.0.0.1", REACH_PORT: "0", REACH_ADMIN_PORT: "0" }, layout);
  assert.ok(!args.includes("--admin-allow-from"), "no allowlist is invented");
  await assert.rejects(startServer(args, { env: { PATH: process.env.PATH } }), /--admin-host outside loopback needs --admin-allow-from/);
});

// ---- Task #90: the public Linux one-line installer, against the real build and a real Server and Client ----
const INSTALL_SH = path.join(import.meta.dirname, "..", "..", "deploy", "client", "install.sh");
const hex = (s) => createHash("sha256").update(s).digest("hex");
const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 100));
  }
};
const installer = (args) => spawnSync("sh", [INSTALL_SH, ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });
const installerAsync = (args) =>
  new Promise((resolve) => {
    const child = spawn("sh", [INSTALL_SH, ...args], { env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.on("exit", (status) => resolve({ status, stderr }));
  });
const machine = (name) => {
  const root = path.join(base, name);
  return { state: path.join(root, "state"), install: path.join(root, "opt", "client"), units: path.join(root, "units") };
};
const flags = (m, origin) => ["--server-origin", origin, "--state-dir", m.state, "--install-dir", m.install, "--unit-dir", m.units, "--test-no-system"];

test("install.sh rejects a bad origin, a cross-origin or unsupported setup and a corrupt manifest before any machine change", async () => {
  const m = machine("rej");
  for (const origin of ["", "https://127.0.0.1:1", "ftp://x", "http://u:p@h", "http://h/path", "http://h?q=1", "http://h#f", "http://-h", "http://h:80x", "127.0.0.1:1"]) {
    const r = installer(flags(m, origin));
    assert.equal(r.status, 2, `${origin}: ${r.stderr}`);
  }
  assert.equal(installer(["--state-dir", m.state]).status, 2, "the origin is required, never guessed");
  assert.ok(!existsSync(m.state) && !existsSync(m.install) && !existsSync(m.units), "nothing was created");
  // A fake origin that serves a manifest with a wrong hash, then one with two selectors, then a redirect to another origin.
  const bad = async (manifestFor, archive) => {
    const server = createServer((req, res) => {
      if (req.url === "/release/manifest") return res.end(JSON.stringify(manifestFor()));
      if (req.url.startsWith("/release/artifacts/")) return res.end(archive);
      res.writeHead(404).end();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const mm = machine(`rej-${Math.random().toString(36).slice(2)}`);
      const r = await installerAsync(flags(mm, `http://127.0.0.1:${server.address().port}`)); // async: this process also hosts the fake origin
      assert.ok(!existsSync(mm.install) && !existsSync(mm.state) && !existsSync(mm.units), "no machine change");
      return r;
    } finally {
      server.close();
    }
  };
  const good = () => JSON.parse(JSON.stringify(manifest));
  const bytes = readFileSync(path.join(out, "artifacts", names.linux));
  assert.match((await bad(() => ({ ...good(), schema_version: 1 }), bytes)).stderr, /schema_version/);
  assert.match((await bad(() => { const x = good(); x.artifacts.push({ ...x.artifacts.find((a) => a.role === "client" && a.os === "linux") }); return x; }, bytes)).stderr, /exactly one client artifact/);
  assert.match((await bad(() => { const x = good(); x.artifacts.find((a) => a.role === "client" && a.os === "linux").download_path = "http://evil/x.tgz"; return x; }, bytes)).stderr, /download_path/);
  assert.match((await bad(() => { const x = good(); x.artifacts.find((a) => a.role === "client" && a.os === "linux").download_path = "/release/artifacts/../x"; return x; }, bytes)).stderr, /download_path/);
  assert.match((await bad(() => good(), Buffer.concat([bytes, Buffer.from("x")]))).stderr, /size/);
  const flipped = Buffer.from(bytes);
  flipped[flipped.length - 1] ^= 1;
  assert.match((await bad(() => good(), flipped)).stderr, /SHA-256/);
});

test("the real one-line install: the Server's own install.sh and manifest-selected archive install a Client that generates its identity locally and registers Pending", async () => {
  const bearer = "mcp-token-" + "Zq81";
  const priv = path.join(base, "e2e-private");
  mkdirSync(priv, { recursive: true });
  writeFileSync(path.join(priv, "config.json"), JSON.stringify({ mcp_bearer_sha256: hex(bearer), clients: [] }));
  const dir = path.join(extract("server"), "reach-server");
  const args = ["reach-server.mjs", "--config", `${priv}/config.json`, "--proposal", `${priv}/proposal.json`, "--logs", `${priv}/logs`, "--port", "0", "--admin-port", "0", "--build", BUILD_ID, "--artifacts", path.join(out, "artifacts")];
  const { child, output } = await startServer(args, { cwd: dir });
  let client = null;
  try {
    const port = /listening port=(\d+) admin_port=(\d+)/.exec(output);
    assert.ok(port, output);
    const origin = `http://127.0.0.1:${port[1]}`;
    const page = await (await fetch(`${origin}/`, { headers: { host: `127.0.0.1:${port[1]}` } })).text();
    assert.ok(page.includes(`curl -fsSL ${origin}/install.sh | sudo sh -s -- --server-origin ${origin}`), "the discovery page passes the origin explicitly");
    const served = Buffer.from(await (await fetch(`${origin}/install.sh`)).arrayBuffer());
    assert.deepEqual(served, readFileSync(path.join(out, "artifacts", "install.sh")), "the Server serves the release-built installer");
    assert.equal(manifest.installers[0].sha256, hex(served));
    const script = path.join(base, "served-install.sh");
    writeFileSync(script, served);

    const m = machine("e2e");
    const run = (extra = []) => spawnSync("sh", [script, ...flags(m, origin), ...extra], { encoding: "utf8", env: { PATH: process.env.PATH } });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const bootstrap = path.join(m.state, "bootstrap.env");
    assert.equal(readFileSync(bootstrap, "utf8"), `REACH_SERVER_URL=ws://127.0.0.1:${port[1]}/client\nREACH_ROOTS=["${m.state}/root"]\n`, "only the endpoint and a narrow root, no identity before first start");
    assert.equal(statSync(bootstrap).mode & 0o777, 0o600);
    assert.notEqual(`${m.state}/root`, "/");
    const unit = readFileSync(path.join(m.units, "reach-mcp-client.service"), "utf8");
    assert.match(unit, new RegExp(`--bootstrap "${bootstrap}" --build ${BUILD_ID} --allow-insecure-ws`));
    assert.doesNotMatch(unit, /REACH_CLIENT|IDENTITY_KEY|Environment=/);
    assert.ok(!(first.stdout + first.stderr).includes("REACH_CLIENT_IDENTITY_KEY"));

    // Start the installed Client exactly as the unit would, and let it generate its own identity.
    client = spawn(process.execPath, [path.join(m.install, "reach-client.mjs"), "--bootstrap", bootstrap, "--build", BUILD_ID, "--allow-insecure-ws"], { stdio: ["ignore", "pipe", "pipe"] });
    let clientOutput = "";
    client.stdout.on("data", (c) => (clientOutput += c));
    client.stderr.on("data", (c) => (clientOutput += c));
    const pending = await waitFor(async () => {
      const view = await (await fetch(`http://127.0.0.1:${port[2]}/admin/api/clients`)).json();
      return view.clients.find((c) => c.status === "pending" || c.enabled === false) ?? null;
    });
    assert.equal((await (await fetch(`http://127.0.0.1:${port[2]}/admin/api/clients`)).json()).clients.length, 1, "exactly one unknown Client");
    const text = readFileSync(bootstrap, "utf8");
    const id = /^REACH_CLIENT_ID=(.+)$/m.exec(text)?.[1];
    const key = /^REACH_CLIENT_IDENTITY_KEY=(.+)$/m.exec(text)?.[1];
    assert.ok(id && key, "the Client wrote its own id and key");
    assert.equal(statSync(bootstrap).mode & 0o777, 0o600, "still protected");
    assert.equal(pending.client_id ?? pending.id, id);
    const surfaces = [first.stdout, first.stderr, clientOutput, unit, JSON.stringify(pending), readFileSync(path.join(priv, "config.json"), "utf8"), JSON.stringify(manifest), page];
    for (const f of collectEntries(path.join(priv, "logs"))) surfaces.push(f.data.toString());
    for (const s of surfaces) assert.ok(!s.includes(key), "the private key is on no Server, installer, unit or log surface");

    // A rerun against the same machine keeps the identity and replaces the runtime.
    client.kill("SIGTERM");
    await new Promise((r) => client.once("exit", r));
    client = null;
    writeFileSync(path.join(m.install, "stale.txt"), "old");
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(bootstrap, "utf8"), text, "the bootstrap, identity included, is untouched by a rerun");
    assert.ok(!existsSync(path.join(m.install, "stale.txt")), "the runtime was replaced");
    // A failed rerun (corrupt download) leaves the previous install and bootstrap intact.
    const broken = machine("e2e");
    const before = readFileSync(path.join(m.install, "reach-client.mjs"), "utf8");
    const refused = spawnSync("sh", [script, ...flags(broken, "http://127.0.0.1:1")], { encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(refused.status, 2);
    assert.equal(readFileSync(path.join(m.install, "reach-client.mjs"), "utf8"), before);
    assert.equal(readFileSync(bootstrap, "utf8"), text);
  } finally {
    if (client) client.kill("SIGKILL");
    await stopChild(child);
  }
});

test("the Windows Client archive carries the pinned Node runtime and its low-level installer; the Linux archive carries neither a node.exe nor the Windows script", () => {
  const win = extract("windows");
  assert.ok(existsSync(path.join(win, "reach-client", "runtime", "node.exe")), "node.exe is inside the Windows archive");
  assert.equal(hex(readFileSync(path.join(win, "reach-client", "runtime", "node.exe"))), "f5109dc868ec38703ad8f305e0aceece717cb60d4889873f434017af4e96cccb", "the pinned node.exe, byte for byte");
  assert.ok(existsSync(path.join(win, "reach-client", "deploy", "install-windows.ps1")));
  const lin = extract("linux");
  assert.ok(!existsSync(path.join(lin, "reach-client", "runtime")) && !existsSync(path.join(lin, "reach-client", "deploy", "install-windows.ps1")));
  assert.ok(existsSync(path.join(lin, "reach-client", "deploy", "install-linux.sh")), "the Linux contract is unchanged");
  assert.deepEqual(manifest.installers.map((i) => [i.name, i.os, i.download_path]), [["install.sh", "linux", "/install.sh"], ["install.ps1", "win32", "/install.ps1"]]);
});
