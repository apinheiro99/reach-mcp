// The production delivery transaction, driven with in-process stand-ins for compose, the build and the running Server. No Docker,
// no network, no real target: it proves the state machine (promotion, automatic and explicit rollback, locking, secret-free evidence).
import { Buffer } from "node:buffer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { deploy, parseArgs, rollback, status } from "../deploy/prod/deploy.mjs";
import { buildManifest, REQUIRED_ARTIFACTS } from "../scripts/release/manifest.mjs";

const base = mkdtempSync(path.join(tmpdir(), "reach-deploy-"));
const BEARER = "deploy-bearer-" + "Qw83Zk17";
let counter = 0;
// The deployment inputs must be real regular files (the controller refuses anything else before touching Docker).
const inputFile = (name) => {
  const file = path.join(base, name);
  writeFileSync(file, "{}\n");
  return file;
};
const TB = inputFile("tunnel-client");
const TD = path.join(base, "tunnel");
mkdirSync(TD, { recursive: true });
const ADMIN_BIND = "127.0.0.1";
const ADMIN_ALLOW = "203.0.113.0/24,127.0.0.1";
const [C1, P1, C2, P2] = ["c1.json", "p1.json", "c2.json", "p2.json"].map(inputFile);

/** A valid canonical release for one build id. */
function release(buildId, commit) {
  const dir = path.join(base, `rel-${counter++}`);
  mkdirSync(path.join(dir, "artifacts"), { recursive: true });
  mkdirSync(path.join(dir, "server"));
  const records = REQUIRED_ARTIFACTS.map((t) => {
    const name = `reach-${t.role}-${t.platform}.${t.os === "win32" ? "zip" : "tgz"}`;
    const bytes = Buffer.from(`${name} ${buildId}`);
    writeFileSync(path.join(dir, t.role === "server" ? "server" : "artifacts", name), bytes);
    return { role: t.role, platform: t.platform, name, bytes };
  });
  writeFileSync(path.join(dir, "artifacts", "manifest.json"), JSON.stringify(buildManifest({ buildId, repositoryCommit: commit, records })));
  return dir;
}

/** A docker that only records, and a fake "Server" whose reported identity follows what compose last started. */
function world({ failImages = new Set(), wrongIdentity = new Set(), unhealthy = new Set() } = {}) {
  const log = [];
  let running = null;
  const dockerBin = path.join(base, `docker-${counter++}.sh`);
  writeFileSync(dockerBin, "#!/bin/sh\nexit 0\n");
  chmodSync(dockerBin, 0o755);
  const deps = {
    run: (cmd, args, env) => {
      assert.deepEqual(args.slice(0, 2), ["compose", "-p"]);
      log.push({ image: env.REACH_IMAGE, config: env.REACH_CONFIG_FILE, proposal: env.REACH_PROPOSAL_FILE, logs: env.REACH_LOG_DIR, adminBind: env.REACH_ADMIN_BIND, adminAllowFrom: env.REACH_ADMIN_ALLOW_FROM });
      if (failImages.has(env.REACH_IMAGE)) throw new Error("compose up failed");
      running = env.REACH_IMAGE;
    },
    http: async (url) => {
      if (running === null || unhealthy.has(running)) throw new Error("connection refused");
      if (url.endsWith("/admin/api/state")) {
        const [, id] = running.split(":");
        const identity = wrongIdentity.has(running) ? { server_build: "other", repository_commit: "0".repeat(40) } : { server_build: id, repository_commit: commitOf.get(id) };
        return { status: 200, body: JSON.stringify({ setup_mode: false, health: identity }) };
      }
      return { status: 401, body: "" };
    },
    sleep: async () => {},
    now: () => "2026-11-16T00:00:00.000Z",
  };
  return { deps, log, docker: dockerBin };
}
const commitOf = new Map();
const make = (id) => {
  const commit = id.padEnd(40, "a").slice(0, 40).replace(/[^0-9a-f]/g, "a");
  commitOf.set(id, commit);
  return { dir: release(id, commit), commit };
};

const opts = (w, rel, state, extra = {}) => ({
  release: rel, state, config: C1, proposal: P1, logs: "/srv/logs", docker: w.docker, tunnelBinary: TB, tunnelDir: TD, project: "reach", imageRepo: "reach-server",
  port: 8787, adminPort: 8788, adminBind: ADMIN_BIND, adminAllowFrom: ADMIN_ALLOW, retries: 2, intervalMs: 0, ...extra,
});
const stateDir = () => path.join(base, `state-${counter++}`);

test("first deploy builds the canonical image, starts it and promotes it only after health, identity and smoke pass", async () => {
  const w = world();
  const r = make("b1");
  const state = stateDir();
  const { exit, evidence } = await deploy(opts(w, r.dir, state), w.deps);
  assert.equal(exit, 0);
  assert.equal(evidence.result, "promoted");
  assert.deepEqual(evidence.checks.map((c) => [c.name, c.ok]), [["health", true], ["running-identity", true], ["smoke-data-plane", true]]);
  const s = status({ state });
  assert.deepEqual([s.current.build_id, s.current.repository_commit, s.current.image], ["b1", r.commit, "reach-server:b1"]);
  assert.equal(s.previous, null);
  assert.deepEqual([s.current.config, s.current.proposal], [C1, P1]);
});

test("a second deploy keeps the first as the previous known-good", async () => {
  const w = world();
  const state = stateDir();
  await deploy(opts(w, make("b1").dir, state), w.deps);
  await deploy(opts(w, make("b2").dir, state, { config: C2 }), w.deps);
  const s = status({ state });
  assert.deepEqual([s.current.build_id, s.previous.build_id], ["b2", "b1"]);
  assert.equal(s.previous.config, C1, "the previous deployment keeps its own config reference");
});

test("a candidate that fails health restores the previous image with its config and proposal, exits non-zero and leaves state untouched", async () => {
  const w = world({ unhealthy: new Set(["reach-server:b2"]) });
  const state = stateDir();
  await deploy(opts(w, make("b1").dir, state), w.deps);
  w.log.length = 0;
  const { exit, evidence } = await deploy(opts(w, make("b2").dir, state, { config: C2, proposal: P2 }), w.deps);
  assert.equal(exit, 1);
  assert.deepEqual([evidence.result, evidence.rollback], ["candidate-failed", "restored"]);
  assert.deepEqual(w.log.map((l) => [l.image, l.config, l.proposal]), [["reach-server:b2", C2, P2], ["reach-server:b1", C1, P1]]);
  const s = status({ state });
  assert.deepEqual([s.current.build_id, s.previous], ["b1", null], "the failed candidate never became known-good");
});

test("a candidate that reports a different build or commit is rolled back and never promoted", async () => {
  const w = world({ wrongIdentity: new Set(["reach-server:b2"]) });
  const state = stateDir();
  await deploy(opts(w, make("b1").dir, state), w.deps);
  const { exit, evidence } = await deploy(opts(w, make("b2").dir, state), w.deps);
  assert.equal(exit, 1);
  assert.equal(evidence.checks.find((c) => c.name === "running-identity").ok, false);
  assert.equal(evidence.rollback, "restored");
  assert.equal(status({ state }).current.build_id, "b1");
});

test("a failed first deploy has nothing to restore and records that", async () => {
  const w = world({ failImages: new Set(["reach-server:b1"]) });
  const state = stateDir();
  const { exit, evidence } = await deploy(opts(w, make("b1").dir, state), w.deps);
  assert.equal(exit, 1);
  assert.equal(evidence.rollback, "no-previous-known-good");
  assert.equal(status({ state }).current, null);
});

test("when the restore itself fails the failure is recorded distinctly and the state still names the previous deployment", async () => {
  const w = world({ unhealthy: new Set(["reach-server:b2"]) });
  const state = stateDir();
  await deploy(opts(w, make("b1").dir, state), w.deps);
  w.deps.http = async () => {
    throw new Error("down");
  };
  const { exit, evidence } = await deploy(opts(w, make("b2").dir, state), w.deps);
  assert.equal(exit, 1);
  assert.equal(evidence.rollback, "restore-unhealthy");
  assert.equal(status({ state }).current.build_id, "b1", "state is not rewritten by a failed transaction");
});

test("explicit rollback restores the previous deployment and swaps current and previous; without a previous it refuses cleanly", async () => {
  const w = world();
  const state = stateDir();
  await deploy(opts(w, make("b1").dir, state), w.deps);
  await assert.rejects(() => rollback(opts(w, "", state), w.deps), /no previous known-good/);
  await deploy(opts(w, make("b2").dir, state), w.deps);
  w.log.length = 0;
  const { exit, evidence } = await rollback(opts(w, "", state), w.deps);
  assert.equal(exit, 0);
  assert.equal(evidence.result, "restored");
  assert.deepEqual(w.log.map((l) => [l.image, l.config]), [["reach-server:b1", C1]]);
  const s = status({ state });
  assert.deepEqual([s.current.build_id, s.previous.build_id], ["b1", "b2"]);
});

test("a corrupted release is refused before anything is built or started", async () => {
  const w = world();
  const r = make("b1");
  writeFileSync(path.join(r.dir, "server", "reach-server-linux-x64.tgz"), "tampered");
  const state = stateDir();
  await assert.rejects(() => deploy(opts(w, r.dir, state), w.deps), /release is not verified/);
  assert.equal(w.log.length, 0);
  assert.equal(status({ state }).current, null);
});

test("a second deployment while one holds the lock is refused, and the lock is released afterwards", async () => {
  const w = world();
  const state = stateDir();
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, "deploy.lock"), "");
  await assert.rejects(() => deploy(opts(w, make("b1").dir, state), w.deps), /another deployment is running/);
  assert.equal(w.log.length, 0);
  const free = stateDir();
  await deploy(opts(w, make("b1").dir, free), w.deps);
  assert.ok(!existsSync(path.join(free, "deploy.lock")));
});

test("state and evidence hold identities, paths and results only, never file contents or a bearer", async () => {
  const w = world();
  const state = stateDir();
  const cfg = path.join(base, "private-config.json");
  writeFileSync(cfg, JSON.stringify({ mcp_bearer: BEARER }));
  const { evidence } = await deploy(opts(w, make("b1").dir, state, { config: cfg }), w.deps);
  const written = readFileSync(path.join(state, "state.json"), "utf8") + readFileSync(path.join(state, "evidence.json"), "utf8") + JSON.stringify(evidence);
  assert.ok(!written.includes(BEARER));
  assert.ok(written.includes(cfg), "the config is referenced by path only");
});

test("a custom evidence path is honoured and the state file is replaced atomically (no temp file left)", async () => {
  const w = world();
  const state = stateDir();
  const evidence = path.join(base, `ev-${counter++}.json`);
  await deploy(opts(w, make("b1").dir, state, { evidence }), w.deps);
  assert.equal(JSON.parse(readFileSync(evidence, "utf8")).result, "promoted");
  assert.ok(!existsSync(path.join(state, "state.json.tmp")));
});

test("the command line requires the operator's target inputs and has no defaults for them", () => {
  assert.throws(() => parseArgs(["deploy", "--state", "/s"]), /missing --release/);
  assert.throws(() => parseArgs(["deploy", "--state", "/s", "--release", "/r", "--config", "/c", "--proposal", "/p"]), /missing --logs/);
  assert.throws(() => parseArgs(["deploy", "--state", "/s", "--release", "/r", "--config", "/c", "--proposal", "/p", "--logs", "/l"]), /missing --tunnel-binary/);
  assert.throws(() => parseArgs(["frobnicate", "--state", "/s"]), /usage/);
  const base = ["--state", "/s", "--logs", "/l", "--tunnel-binary", "/tb", "--tunnel-dir", "/td"];
  const deployBase = [...base, "--release", "/r", "--config", "/c", "--proposal", "/p"];
  const admin = ["--admin-bind", "127.0.0.1", "--admin-allow-from", "203.0.113.0/24"];
  const a = parseArgs(["deploy", ...deployBase, ...admin]);
  assert.deepEqual([a.port, a.adminPort, a.docker, a.project, a.adminBind, a.adminAllowFrom], [8787, 8788, "docker", "reach", "127.0.0.1", "203.0.113.0/24"]);
  assert.deepEqual([parseArgs(["rollback", ...base, ...admin]).command, parseArgs(["rollback", ...base, ...admin]).adminAllowFrom], ["rollback", "203.0.113.0/24"]);
});

test("the Admin exposure policy is explicit: deploy and rollback refuse a missing or empty bind or allowlist, and status needs neither", () => {
  const base = ["--state", "/s", "--logs", "/l", "--tunnel-binary", "/tb", "--tunnel-dir", "/td"];
  const deployBase = [...base, "--release", "/r", "--config", "/c", "--proposal", "/p"];
  for (const command of [["deploy", deployBase], ["rollback", base]]) {
    assert.throws(() => parseArgs([command[0], ...command[1]]), /missing --admin-bind/);
    assert.throws(() => parseArgs([command[0], ...command[1], "--admin-bind", "127.0.0.1"]), /missing --admin-allow-from/);
    assert.throws(() => parseArgs([command[0], ...command[1], "--admin-bind", "", "--admin-allow-from", "127.0.0.1"]), /--admin-bind must not be empty/);
    assert.throws(() => parseArgs([command[0], ...command[1], "--admin-bind", "127.0.0.1", "--admin-allow-from", ""]), /--admin-allow-from must not be empty/);
  }
  assert.equal(parseArgs(["status", "--state", "/s"]).command, "status");
});

test("deploy and rollback hand the explicit Admin bind and allowlist to Compose, never an ambient value", async () => {
  process.env.REACH_ADMIN_BIND = "ambient-must-not-win";
  const w = world();
  const state = stateDir();
  try {
    await deploy(opts(w, make("b1").dir, state), w.deps);
    await deploy(opts(w, make("b2").dir, state), w.deps);
    await rollback(opts(w, "", state), w.deps);
  } finally {
    delete process.env.REACH_ADMIN_BIND;
  }
  assert.equal(w.log.length, 3);
  assert.ok(w.log.every((l) => l.adminBind === ADMIN_BIND && l.adminAllowFrom === ADMIN_ALLOW), "deploy, deploy and rollback all carry the same explicit policy");
});

test("the deployment sources define no private target and run no background updater", () => {
  for (const name of ["deploy.mjs", "remote-deploy.sh"]) {
    const src = readFileSync(path.join(import.meta.dirname, "..", "deploy", "prod", name), "utf8").replace(/^\s*(#|\/\/).*$/gm, "");
    assert.doesNotMatch(src, /192\.168\.|\.lab\b|reach-private|setInterval|watchtower|cron|auto-?update|docker\.sock/i, name);
  }
  assert.ok(process.env.PATH !== undefined);
});

test("the CI transport script refuses to run without the operator's target variables and has no defaults for them", () => {
  const script = path.join(import.meta.dirname, "..", "deploy", "prod", "remote-deploy.sh");
  const run = (args, env) => spawnSync("bash", [script, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  assert.equal(run(["bogus"], {}).status, 2);
  const noTarget = run(["rollback"], {});
  assert.notEqual(noTarget.status, 0);
  assert.match(noTarget.stderr, /DEPLOY_HOST/);
  const unsafe = run(["rollback"], { DEPLOY_HOST: "h;x", DEPLOY_USER: "u", DEPLOY_SSH_KEY: "/k", DEPLOY_KNOWN_HOSTS: "/kh", DEPLOY_DIR: "/d", DEPLOY_LOGS: "/l" });
  assert.equal(unsafe.status, 2);
  assert.match(unsafe.stderr, /outside letters/);
  const src = readFileSync(script, "utf8");
  assert.ok(!/DEPLOY_[A-Z_]+:-/.test(src), "no ${DEPLOY_*:-default}");
  assert.match(src, /StrictHostKeyChecking=yes/);
});

/** A valid two-record state written by hand, then damaged in one way. */
const goodRecord = (id) => ({ build_id: id, repository_commit: "a".repeat(40), image: `reach-server:${id}`, config: "/c", proposal: "/p", deployed_at: "2026-11-16T00:00:00.000Z" });
const writeState = (state, content) => {
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, "state.json"), content);
};

test("an existing state that is malformed, unsupported or incomplete stops deploy, rollback and status before any Docker action and is left untouched", async () => {
  const damaged = {
    "malformed json": "{ not json",
    "empty file": "",
    "not an object": "[]",
    "unsupported schema": JSON.stringify({ schema_version: 2, current: null, previous: null }),
    "missing schema": JSON.stringify({ current: null, previous: null }),
    "missing current key": JSON.stringify({ schema_version: 1, previous: null }),
    "truncated record": JSON.stringify({ schema_version: 1, current: { build_id: "b1" }, previous: null }),
    "bad commit": JSON.stringify({ schema_version: 1, current: { ...goodRecord("b1"), repository_commit: "abc" }, previous: null }),
    "empty field": JSON.stringify({ schema_version: 1, current: goodRecord("b1"), previous: { ...goodRecord("b0"), config: "" } }),
    "record is a string": JSON.stringify({ schema_version: 1, current: "b1", previous: null }),
  };
  for (const [label, content] of Object.entries(damaged)) {
    const w = world();
    const state = stateDir();
    writeState(state, content);
    await assert.rejects(() => deploy(opts(w, make("b9").dir, state), w.deps), /deployment state .* (is not valid JSON|is invalid)/, `deploy: ${label}`);
    await assert.rejects(() => rollback(opts(w, "", state), w.deps), /deployment state/, `rollback: ${label}`);
    assert.throws(() => status({ state }), /deployment state/, `status: ${label}`);
    assert.equal(w.log.length, 0, `${label}: no compose call`);
    assert.equal(readFileSync(path.join(state, "state.json"), "utf8"), content, `${label}: the file is not rewritten`);
    assert.ok(!existsSync(path.join(state, "evidence.json")), `${label}: no evidence claims anything`);
    assert.ok(!existsSync(path.join(state, "deploy.lock")), `${label}: the lock is released`);
  }
});

test("a state path that cannot be read as a file stops the command instead of becoming an empty state", async () => {
  const w = world();
  const state = stateDir();
  mkdirSync(path.join(state, "state.json"), { recursive: true });
  await assert.rejects(() => deploy(opts(w, make("b9").dir, state), w.deps), /cannot be read/);
  assert.equal(w.log.length, 0);
});

test("a valid two-record state is accepted and a missing state file is still a first deployment", async () => {
  const w = world();
  const state = stateDir();
  writeState(state, JSON.stringify({ schema_version: 1, current: goodRecord("b2"), previous: goodRecord("b1") }));
  assert.equal(status({ state }).previous.build_id, "b1");
  const fresh = stateDir();
  assert.deepEqual(status({ state: fresh }), { schema_version: 1, current: null, previous: null });
  assert.equal((await deploy(opts(w, make("b1").dir, fresh), w.deps)).exit, 0);
});

test("a missing or non-file deployment input is refused before anything is built or started", async () => {
  const w = world();
  for (const extra of [{ config: path.join(base, "absent.json") }, { proposal: base }, { tunnelBinary: path.join(base, "absent-tunnel") }, { tunnelDir: C1 }]) {
    const state = stateDir();
    const { exit, evidence } = await deploy(opts(w, make("b7").dir, state, extra), w.deps);
    assert.equal(exit, 1);
    assert.match(evidence.checks[0].error, /missing or of the wrong kind/);
    assert.equal(w.log.length, 0, "compose never ran");
    assert.equal(status({ state }).current, null);
  }
});

test("a data plane that answers 503 (no active configuration) fails the smoke check and reports the status", async () => {
  const w = world();
  const http = w.deps.http;
  w.deps.http = async (url) => (url.endsWith("/health") ? { status: 503, body: "" } : http(url));
  const { exit, evidence } = await deploy(opts(w, make("b8").dir, stateDir()), w.deps);
  assert.equal(exit, 1);
  assert.deepEqual(evidence.checks.find((c) => c.name === "smoke-data-plane"), { name: "smoke-data-plane", ok: false, data_plane_status: 503 });
});
