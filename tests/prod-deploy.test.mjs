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
      log.push({ image: env.REACH_IMAGE, config: env.REACH_CONFIG_FILE, proposal: env.REACH_PROPOSAL_FILE, logs: env.REACH_LOG_DIR });
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
  release: rel, state, config: "/srv/cfg/config.json", proposal: "/srv/cfg/proposal.json", logs: "/srv/logs", docker: w.docker, project: "reach-server", imageRepo: "reach-server",
  dataPort: 8787, adminPort: 8788, retries: 2, intervalMs: 0, ...extra,
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
  assert.deepEqual([s.current.config, s.current.proposal], ["/srv/cfg/config.json", "/srv/cfg/proposal.json"]);
});

test("a second deploy keeps the first as the previous known-good", async () => {
  const w = world();
  const state = stateDir();
  await deploy(opts(w, make("b1").dir, state), w.deps);
  await deploy(opts(w, make("b2").dir, state, { config: "/srv/cfg2/config.json" }), w.deps);
  const s = status({ state });
  assert.deepEqual([s.current.build_id, s.previous.build_id], ["b2", "b1"]);
  assert.equal(s.previous.config, "/srv/cfg/config.json", "the previous deployment keeps its own config reference");
});

test("a candidate that fails health restores the previous image with its config and proposal, exits non-zero and leaves state untouched", async () => {
  const w = world({ unhealthy: new Set(["reach-server:b2"]) });
  const state = stateDir();
  await deploy(opts(w, make("b1").dir, state), w.deps);
  w.log.length = 0;
  const { exit, evidence } = await deploy(opts(w, make("b2").dir, state, { config: "/srv/cfg2/config.json", proposal: "/srv/cfg2/proposal.json" }), w.deps);
  assert.equal(exit, 1);
  assert.deepEqual([evidence.result, evidence.rollback], ["candidate-failed", "restored"]);
  assert.deepEqual(w.log.map((l) => [l.image, l.config, l.proposal]), [["reach-server:b2", "/srv/cfg2/config.json", "/srv/cfg2/proposal.json"], ["reach-server:b1", "/srv/cfg/config.json", "/srv/cfg/proposal.json"]]);
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
  assert.deepEqual(w.log.map((l) => [l.image, l.config]), [["reach-server:b1", "/srv/cfg/config.json"]]);
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
  assert.throws(() => parseArgs(["frobnicate", "--state", "/s"]), /usage/);
  const a = parseArgs(["deploy", "--state", "/s", "--release", "/r", "--config", "/c", "--proposal", "/p", "--logs", "/l"]);
  assert.deepEqual([a.dataPort, a.adminPort, a.docker], [8787, 8788, "docker"]);
  assert.equal(parseArgs(["rollback", "--state", "/s", "--logs", "/l"]).command, "rollback");
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
