// The production delivery transaction, driven with in-process stand-ins for compose, the build and the running Server. No Docker,
// no external network (one loopback probe), no real target: it proves the state machine (promotion, automatic and explicit rollback, locking, secret-free evidence).
import { Buffer } from "node:buffer";
import { test } from "node:test";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { bootstrapPrivateRoot, defaultDeps, deploy, parseArgs, rollback, status, type Deps, type Options } from "../deploy/prod/deploy.ts";
import { buildManifest, INSTALLERS, REQUIRED_ARTIFACTS, type Untrusted } from "../scripts/release/manifest.ts";

const base = mkdtempSync(path.join(tmpdir(), "reach-deploy-"));
const BEARER = "deploy-bearer-" + "Qw83Zk17";
let counter = 0;
// The deployment inputs must be real regular files (the controller refuses anything else before touching Docker).
const inputFile = (name: string) => {
  const file = path.join(base, name);
  writeFileSync(file, "{}\n");
  return file;
};
const TB = inputFile("tunnel-client");
const TD = path.join(base, "tunnel");
mkdirSync(TD, { recursive: true });
const ADMIN_BIND = "127.0.0.1";
const ADMIN_ALLOW = "203.0.113.0/24,127.0.0.1";
const NOT_A_DIR = inputFile("not-a-dir.json");
const PRIVATE = path.join(base, "reach-private");

/** A valid canonical release for one build id. */
function release(buildId: string, commit: string) {
  const dir = path.join(base, `rel-${counter++}`);
  mkdirSync(path.join(dir, "artifacts"), { recursive: true });
  mkdirSync(path.join(dir, "server"));
  const records = REQUIRED_ARTIFACTS.map((t) => {
    const name = `reach-${t.role}-${t.platform}.${t.os === "win32" ? "zip" : "tgz"}`;
    const bytes = Buffer.from(`${name} ${buildId}`);
    writeFileSync(path.join(dir, t.role === "server" ? "server" : "artifacts", name), bytes);
    return { role: t.role, platform: t.platform, name, bytes };
  });
  const installers = INSTALLERS.map(({ name }) => ({ name, bytes: Buffer.from(`${name} stand-in`) }));
  for (const i of installers) writeFileSync(path.join(dir, "artifacts", i.name), i.bytes);
  writeFileSync(path.join(dir, "artifacts", "manifest.json"), JSON.stringify(buildManifest({ buildId, repositoryCommit: commit, records, installers })));
  return dir;
}

/** A docker that only records, and a fake "Server" whose reported identity follows what compose last started. */
function world({ failImages = new Set<string>(), wrongIdentity = new Set<string>(), unhealthy = new Set<string>(), malformed = new Set<string>() } = {}) {
  const log: Record<string, string | undefined>[] = [];
  const urls: string[] = [];
  let running: string | null = null;
  const dockerBin = path.join(base, `docker-${counter++}.sh`);
  writeFileSync(dockerBin, "#!/bin/sh\nexit 0\n");
  chmodSync(dockerBin, 0o755);
  const deps: Deps = {
    run: (cmd, args, env) => {
      assert.deepEqual(args.slice(0, 2), ["compose", "-p"]);
      log.push({ image: env.REACH_IMAGE, privatePath: env.REACH_PRIVATE_PATH, adminBind: env.REACH_ADMIN_BIND, adminAllowFrom: env.REACH_ADMIN_ALLOW_FROM });
      if (failImages.has(env.REACH_IMAGE!)) throw new Error("compose up failed");
      running = env.REACH_IMAGE!;
    },
    http: async (url) => {
      urls.push(url);
      if (running === null || unhealthy.has(running)) throw new Error("connection refused");
      if (url.endsWith("/release/manifest")) {
        if (malformed.has(running)) return { status: 200, body: "<html>not a manifest" };
        const [, id] = running.split(":");
        const release = wrongIdentity.has(running) ? { build_id: "other", repository_commit: "0".repeat(40) } : { build_id: id, repository_commit: commitOf.get(id!) };
        return { status: 200, body: JSON.stringify({ release }) };
      }
      return { status: 401, body: "", challenge: "Bearer" };
    },
    sleep: async () => {},
    now: () => "2026-11-16T00:00:00.000Z",
    uid: () => process.getuid!(),
    // A root deployer (the CI container) chowns by design; only a non-root deployer that already owns the root must never chown.
    chown: () => {
      if (process.getuid!() !== 0) assert.fail("a deployer that already owns the root never chowns");
    },
  };
  return { deps, log, urls, docker: dockerBin };
}
const commitOf = new Map<string, string>();
const make = (id: string) => {
  const commit = id.padEnd(40, "a").slice(0, 40).replace(/[^0-9a-f]/g, "a");
  commitOf.set(id, commit);
  return { dir: release(id, commit), commit };
};

const opts = (w: { docker: string }, rel: string, state: string, extra: Partial<Options> = {}): Options => ({
  release: rel, state, privatePath: PRIVATE, containerUid: process.getuid!(), docker: w.docker, tunnelBinary: TB, tunnelDir: TD, project: "reach", imageRepo: "reach-server",
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
  assert.deepEqual(evidence.checks.map((c: Untrusted) => [c.name, c.ok]), [["health", true], ["running-identity", true], ["smoke-data-plane", true]]);
  const s = status({ state });
  assert.deepEqual([s.current.build_id, s.current.repository_commit, s.current.image], ["b1", r.commit, "reach-server:b1"]);
  assert.equal(s.previous, null);
  assert.equal(s.current.private_path, PRIVATE);
  assert.ok(statSync(PRIVATE).isDirectory(), "a missing private root is created before Docker");
});

test("a second deploy keeps the first as the previous known-good", async () => {
  const w = world();
  const state = stateDir();
  await deploy(opts(w, make("b1").dir, state), w.deps);
  await deploy(opts(w, make("b2").dir, state), w.deps);
  const s = status({ state });
  assert.deepEqual([s.current.build_id, s.previous.build_id], ["b2", "b1"]);
  assert.equal(s.previous.private_path, PRIVATE, "both deployments name the one private root");
});

test("a candidate that fails health restores the previous image on the same private root, exits non-zero and leaves state untouched", async () => {
  const w = world({ unhealthy: new Set(["reach-server:b2"]) });
  const state = stateDir();
  await deploy(opts(w, make("b1").dir, state), w.deps);
  w.log.length = 0;
  const { exit, evidence } = await deploy(opts(w, make("b2").dir, state), w.deps);
  assert.equal(exit, 1);
  assert.deepEqual([evidence.result, evidence.rollback], ["candidate-failed", "restored"]);
  assert.deepEqual(w.log.map((l) => [l.image, l.privatePath]), [["reach-server:b2", PRIVATE], ["reach-server:b1", PRIVATE]]);
  const s = status({ state });
  assert.deepEqual([s.current.build_id, s.previous], ["b1", null], "the failed candidate never became known-good");
});

test("a candidate that reports a different build or commit is rolled back and never promoted", async () => {
  const w = world({ wrongIdentity: new Set(["reach-server:b2"]) });
  const state = stateDir();
  await deploy(opts(w, make("b1").dir, state), w.deps);
  const { exit, evidence } = await deploy(opts(w, make("b2").dir, state), w.deps);
  assert.equal(exit, 1);
  assert.equal(evidence.checks.find((c: Untrusted) => c.name === "running-identity").ok, false);
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
  assert.deepEqual(w.log.map((l) => [l.image, l.privatePath]), [["reach-server:b1", PRIVATE]]);
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
  const root = path.join(base, `private-${counter++}`);
  mkdirSync(root, { mode: 0o700 });
  writeFileSync(path.join(root, "config.json"), JSON.stringify({ mcp_bearer: BEARER }));
  const { evidence } = await deploy(opts(w, make("b1").dir, state, { privatePath: root }), w.deps);
  const written = readFileSync(path.join(state, "state.json"), "utf8") + readFileSync(path.join(state, "evidence.json"), "utf8") + JSON.stringify(evidence);
  assert.ok(!written.includes(BEARER));
  assert.ok(written.includes(root), "the private root is referenced by path only");
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
  assert.throws(() => parseArgs(["deploy", "--state", "/s", "--release", "/r"]), /missing --tunnel-binary/);
  assert.throws(() => parseArgs(["deploy", "--state", "/s", "--release", "/r", "--tunnel-binary", "/tb", "--tunnel-dir", "/td", "--admin-bind", "127.0.0.1", "--admin-allow-from", "127.0.0.1"]), /missing --private-path/);
  assert.throws(() => parseArgs(["frobnicate", "--state", "/s"]), /usage/);
  const base = ["--state", "/s", "--tunnel-binary", "/tb", "--tunnel-dir", "/td"];
  const deployBase = [...base, "--release", "/r"];
  const admin = ["--admin-bind", "127.0.0.1", "--admin-allow-from", "203.0.113.0/24", "--private-path", "/p"];
  const a = parseArgs(["deploy", ...deployBase, ...admin]);
  assert.deepEqual([a.port, a.adminPort, a.docker, a.project, a.adminBind, a.adminAllowFrom, a.privatePath], [8787, 8788, "docker", "reach", "127.0.0.1", "203.0.113.0/24", "/p"]);
  assert.deepEqual([parseArgs(["rollback", ...base, ...admin]).command, parseArgs(["rollback", ...base, ...admin]).adminAllowFrom], ["rollback", "203.0.113.0/24"]);
});

test("the deployment policy is explicit: deploy and rollback refuse a missing or empty Admin bind, Admin allowlist or private root, and status needs none", () => {
  const base = ["--state", "/s", "--tunnel-binary", "/tb", "--tunnel-dir", "/td"];
  const deployBase = [...base, "--release", "/r"];
  for (const command of [["deploy", deployBase], ["rollback", base]] as [string, string[]][]) {
    assert.throws(() => parseArgs([command[0], ...command[1]]), /missing --admin-bind/);
    assert.throws(() => parseArgs([command[0], ...command[1], "--admin-bind", "127.0.0.1"]), /missing --admin-allow-from/);
    assert.throws(() => parseArgs([command[0], ...command[1], "--admin-bind", "", "--admin-allow-from", "127.0.0.1"]), /--admin-bind must not be empty/);
    assert.throws(() => parseArgs([command[0], ...command[1], "--admin-bind", "127.0.0.1", "--admin-allow-from", ""]), /--admin-allow-from must not be empty/);
    assert.throws(() => parseArgs([command[0], ...command[1], "--admin-bind", "127.0.0.1", "--admin-allow-from", "127.0.0.1"]), /missing --private-path/);
    assert.throws(() => parseArgs([command[0], ...command[1], "--admin-bind", "127.0.0.1", "--admin-allow-from", "127.0.0.1", "--private-path", ""]), /--private-path must not be empty/);
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
  for (const name of ["deploy.ts"]) {
    const src = readFileSync(path.join(import.meta.dirname, "..", "deploy", "prod", name), "utf8").replace(/^\s*(#|\/\/).*$/gm, "");
    assert.doesNotMatch(src, /192\.168\.|\.lab\b|reach-private|setInterval|watchtower|cron|auto-?update|docker\.sock/i, name);
  }
  assert.ok(process.env.PATH !== undefined);
});

test("one controller contract: nothing under deploy/prod or the pipeline still calls deploy.ts with the removed --config, --proposal or --logs flags", () => {
  const dir = path.join(import.meta.dirname, "..", "deploy", "prod");
  const callers = [...readdirSync(dir).map((name) => path.join(dir, name)), path.join(import.meta.dirname, "..", ".gitlab-ci.yml")];
  for (const file of callers) assert.doesNotMatch(readFileSync(file, "utf8").replace(/^\s*(#|\/\/).*$/gm, ""), /deploy\.ts[^\n]*--(config|proposal|logs)\b/, file);
  assert.ok(!existsSync(path.join(dir, "remote-deploy.sh")), "the stale SSH wrapper is gone");
});

/** A valid two-record state written by hand, then damaged in one way. */
const goodRecord = (id: string) => ({ build_id: id, repository_commit: "a".repeat(40), image: `reach-server:${id}`, private_path: PRIVATE, deployed_at: "2026-11-16T00:00:00.000Z" });
const writeState = (state: string, content: string) => {
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(state, "state.json"), content);
};

test("an existing state that is malformed, unsupported or incomplete stops deploy, rollback and status before any Docker action and is left untouched", async () => {
  const damaged = {
    "malformed json": "{ not json",
    "empty file": "",
    "not an object": "[]",
    "unsupported schema": JSON.stringify({ schema_version: 3, current: null, previous: null }),
    "missing schema": JSON.stringify({ current: null, previous: null }),
    "missing current key": JSON.stringify({ schema_version: 2, previous: null }),
    "truncated record": JSON.stringify({ schema_version: 2, current: { build_id: "b1" }, previous: null }),
    "bad commit": JSON.stringify({ schema_version: 2, current: { ...goodRecord("b1"), repository_commit: "abc" }, previous: null }),
    "empty field": JSON.stringify({ schema_version: 2, current: goodRecord("b1"), previous: { ...goodRecord("b0"), private_path: "" } }),
    "record is a string": JSON.stringify({ schema_version: 2, current: "b1", previous: null }),
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
  writeState(state, JSON.stringify({ schema_version: 2, current: goodRecord("b2"), previous: goodRecord("b1") }));
  assert.equal(status({ state }).previous.build_id, "b1");
  const fresh = stateDir();
  assert.deepEqual(status({ state: fresh }), { schema_version: 2, current: null, previous: null });
  assert.equal((await deploy(opts(w, make("b1").dir, fresh), w.deps)).exit, 0);
});

test("a missing or non-file tunnel input is refused before anything is built or started", async () => {
  const w = world();
  for (const extra of [{ tunnelBinary: path.join(base, "absent-tunnel") }, { tunnelDir: NOT_A_DIR }]) {
    const state = stateDir();
    const { exit, evidence } = await deploy(opts(w, make("b7").dir, state, extra), w.deps);
    assert.equal(exit, 1);
    assert.match(evidence.checks[0].error, /missing or of the wrong kind/);
    assert.equal(w.log.length, 0, "compose never ran");
    assert.equal(status({ state }).current, null);
  }
});

test("only the exact unauthenticated Bearer challenge passes the smoke; anything else is not promoted and the previous deployment is restored", async () => {
  const answers: [string, { status: number; body: string; challenge?: string | null } | null][] = [
    ["connection failure", null],
    ["404", { status: 404, body: "" }],
    ["302", { status: 302, body: "" }],
    ["307", { status: 307, body: "", challenge: "Bearer" }],
    ["200", { status: 200, body: "ok" }],
    ["204", { status: 204, body: "" }],
    ["503 setup mode", { status: 503, body: "" }],
    ["401 without challenge", { status: 401, body: "", challenge: null }],
    ["401 wrong challenge", { status: 401, body: "", challenge: "Basic" }],
    ["401 with a body", { status: 401, body: "SMOKE-BODY-MARKER", challenge: "Bearer" }],
  ];
  for (const [label, answer] of answers) {
    const w = world();
    const state = stateDir();
    await deploy(opts(w, make("b1").dir, state), w.deps);
    const http = w.deps.http;
    let running = "";
    const run = w.deps.run;
    w.deps.run = (cmd, args, env) => { running = env.REACH_IMAGE!; return run(cmd, args, env); };
    w.deps.http = async (url) => {
      if (!url.endsWith("/health") || running !== "reach-server:b8") return http(url);
      if (answer === null) throw new Error("connection refused");
      return answer;
    };
    const { exit, evidence } = await deploy(opts(w, make("b8").dir, state), w.deps);
    assert.equal(exit, 1, label);
    assert.deepEqual([evidence.result, evidence.rollback], ["candidate-failed", "restored"], label);
    assert.deepEqual(evidence.checks.find((c: Untrusted) => c.name === "smoke-data-plane"),
      { name: "smoke-data-plane", ok: false, data_plane_status: answer?.status ?? 0, bearer_challenge: answer?.challenge === "Bearer", empty_body: !answer?.body }, label);
    assert.equal(status({ state }).current.build_id, "b1", label);
    assert.ok(!JSON.stringify(evidence).includes("SMOKE-BODY-MARKER"), label);
  }
});

test("the real probe never follows a redirect and reports the authentication challenge", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/moved") return void res.writeHead(302, { location: "/health" }).end();
    res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const { http } = defaultDeps();
  assert.equal((await http(`${origin}/moved`)).status, 302);
  assert.deepEqual(await http(`${origin}/health`), { status: 401, body: "", challenge: "Bearer" });
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

test("readiness and running identity come from the service plane's release manifest and never from the Admin plane", async () => {
  const w = world();
  const { exit } = await deploy(opts(w, make("b1").dir, stateDir()), w.deps);
  assert.equal(exit, 0);
  assert.ok(w.urls.length > 0 && w.urls.every((u) => !/\/admin\b|:8788/.test(u)), `no Admin URL is requested: ${w.urls.join(" ")}`);
  assert.ok(w.urls.includes("http://127.0.0.1:8787/release/manifest"));
});

test("a manifest that is malformed, or names another build, never promotes the candidate and the previous deployment is restored", async () => {
  for (const [label, w] of [["malformed", world({ malformed: new Set(["reach-server:b2"]) })], ["wrong identity", world({ wrongIdentity: new Set(["reach-server:b2"]) })]] as [string, ReturnType<typeof world>][]) {
    const state = stateDir();
    await deploy(opts(w, make("b1").dir, state), w.deps);
    const { exit, evidence } = await deploy(opts(w, make("b2").dir, state), w.deps);
    assert.equal(exit, 1, label);
    assert.equal(evidence.result, "candidate-failed", label);
    assert.equal(evidence.rollback, "restored", label);
    assert.equal(status({ state }).current.build_id, "b1", label);
  }
});

const record = (id: string, privatePath: string | null) => ({ ...goodRecord(id), private_path: privatePath });

/** The previous deployment's layout on the host: <old>/config/{server.json,proposal.json} and <old>/logs/, recorded in a schema 1 state. */
function legacyHost({ proposalDir = "config" } = {}) {
  const old = path.join(base, `legacy-${counter++}`);
  mkdirSync(path.join(old, "config"), { recursive: true });
  mkdirSync(path.join(old, "logs", "sub"), { recursive: true });
  mkdirSync(path.join(old, proposalDir), { recursive: true });
  writeFileSync(path.join(old, "config", "server.json"), '{"mcp_bearer":"legacy-bytes"}');
  writeFileSync(path.join(old, proposalDir, "proposal.json"), '{"proposal":1}');
  writeFileSync(path.join(old, "logs", "server.log"), "line 1\n");
  writeFileSync(path.join(old, "logs", "sub", "audit.log"), "audit\n");
  const state = stateDir();
  const rec = (id: string) => ({ ...goodRecord(id), private_path: undefined, config: path.join(old, "config", "server.json"), proposal: path.join(old, proposalDir, "proposal.json") });
  writeState(state, JSON.stringify({ schema_version: 1, current: rec("b1"), previous: null }));
  return { old, state };
}
const fresh = () => path.join(base, `new-root-${counter++}`);

test("a schema 1 state is read as schema 2 (legacy paths dropped from the records, private root unknown) and its legacy paths are never written back", async () => {
  const { state } = legacyHost();
  const read = status({ state });
  assert.deepEqual([read.schema_version, read.current.private_path, "config" in read.current, "proposal" in read.current], [2, null, false, false]);
  const w = world();
  const root = fresh();
  assert.equal((await deploy(opts(w, make("b2").dir, state, { privatePath: root }), w.deps)).exit, 0);
  const after = JSON.parse(readFileSync(path.join(state, "state.json"), "utf8"));
  assert.deepEqual([after.schema_version, after.current.private_path, after.previous.private_path, "legacy" in after], [2, root, null, false]);
  assert.ok(!/server\.json|proposal\.json/.test(JSON.stringify(after)), "no legacy path persisted");
});

test("first upgrade from the canonical legacy layout copies config, proposal and logs byte for byte into the private root BEFORE Compose, keeps the source, and update and rollback then reuse the root", async () => {
  const { old, state } = legacyHost();
  const root = fresh();
  const w = world();
  const seen: string[][] = [];
  const run = w.deps.run;
  w.deps.run = (cmd, args, env) => {
    seen.push([readFileSync(path.join(root, "config.json"), "utf8"), readFileSync(path.join(root, "proposal.json"), "utf8"), readFileSync(path.join(root, "logs", "sub", "audit.log"), "utf8")]);
    return run(cmd, args, env);
  };
  assert.equal((await deploy(opts(w, make("b2").dir, state, { privatePath: root }), w.deps)).exit, 0);
  assert.deepEqual(seen[0], ['{"mcp_bearer":"legacy-bytes"}', '{"proposal":1}', "audit\n"], "the data was already in place when Compose ran");
  assert.equal(readFileSync(path.join(root, "logs", "server.log"), "utf8"), "line 1\n");
  assert.equal(readFileSync(path.join(old, "config", "server.json"), "utf8"), '{"mcp_bearer":"legacy-bytes"}', "the legacy source is left intact");
  assert.ok(!existsSync(path.join(root, ".legacy-migration")), "no staging directory is left behind");
  writeFileSync(path.join(root, "config.json"), '{"edited":"after migration"}');
  assert.equal((await deploy(opts(w, make("b3").dir, state, { privatePath: root }), w.deps)).exit, 0);
  assert.equal((await rollback(opts(w, "", state, { privatePath: root }), w.deps)).exit, 0);
  assert.equal(readFileSync(path.join(root, "config.json"), "utf8"), '{"edited":"after migration"}', "later runs never re-migrate over the live data");
});

test("a failed first candidate leaves the schema 1 state untouched and the retry is accepted again over its own identical copy", async () => {
  const { state } = legacyHost();
  const root = fresh();
  const w = world({ unhealthy: new Set(["reach-server:b2"]) });
  const first = await deploy(opts(w, make("b2").dir, state, { privatePath: root }), w.deps);
  assert.equal(first.exit, 1);
  assert.equal(JSON.parse(readFileSync(path.join(state, "state.json"), "utf8")).schema_version, 1, "not promoted, not rewritten");
  const w2 = world();
  assert.equal((await deploy(opts(w2, make("b2").dir, state, { privatePath: root }), w2.deps)).exit, 0);
});

test("an ambiguous, incomplete or conflicting legacy migration fails before Docker and promotes nothing", async () => {
  const cases: Record<string, [{ state: string }, (root: string) => string, RegExp]> = {
    "config and proposal in different directories": [legacyHost({ proposalDir: "elsewhere" }), (root) => root, /not siblings/],
    "legacy config file missing": [(() => { const h = legacyHost(); rmSync(path.join(h.old, "config", "server.json")); return h; })(), (root) => root, /is missing/],
    "private root already holds a different config": [legacyHost(), (root) => { mkdirSync(root, { recursive: true }); writeFileSync(path.join(root, "config.json"), "{}"); return root; }, /refusing to overwrite/],
    "private root already holds logs": [legacyHost(), (root) => { mkdirSync(path.join(root, "logs"), { recursive: true }); writeFileSync(path.join(root, "logs", "x.log"), "x"); return root; }, /refusing to overwrite/],
  };
  for (const [label, [{ state }, prepare, expected]] of Object.entries(cases)) {
    const w = world();
    const root = prepare(fresh());
    const before = readFileSync(path.join(state, "state.json"), "utf8");
    await assert.rejects(() => deploy(opts(w, make("b2").dir, state, { privatePath: root }), w.deps), expected, label);
    assert.equal(w.log.length, 0, `${label}: compose never ran`);
    assert.equal(readFileSync(path.join(state, "state.json"), "utf8"), before, `${label}: state untouched`);
    assert.ok(!existsSync(path.join(root, ".legacy-migration")), `${label}: no staging left`);
  }
});

test("a missing private root is created only when it can be handed to the container user safely: same uid, or root chowning just the new directory; otherwise nothing is created", async () => {
  const me = process.getuid!();
  const attempt = async (deployerUid: number, root: string, extra: Partial<Options> = {}) => {
    const w = world();
    const chowned: [string, number][] = [];
    w.deps.uid = () => deployerUid;
    w.deps.chown = (file, uid) => {
      chowned.push([file, uid]);
    };
    const run = () => deploy(opts(w, make("b4").dir, stateDir(), { privatePath: root, ...extra }), w.deps);
    return { w, chowned, run };
  };
  const same = await attempt(me, fresh());
  assert.equal((await same.run()).exit, 0);
  assert.deepEqual(same.chowned, [], "the container user created it: nothing to chown");
  const rootRoot = fresh();
  const privileged = await attempt(0, rootRoot, { containerUid: me });
  assert.equal((await privileged.run()).exit, 0);
  // Running as root itself, the deployer already is the container user, so there is nothing to hand over.
  if (me !== 0) assert.deepEqual(privileged.chowned, [[rootRoot, me]], "exactly the new root is handed over, never recursively");
  const foreign = fresh();
  const unprivileged = await attempt(me + 7, foreign);
  await assert.rejects(unprivileged.run, /cannot create a directory owned by uid/);
  assert.ok(!existsSync(foreign) && unprivileged.w.log.length === 0, "nothing was created and Compose never ran");
  const existing = fresh();
  mkdirSync(existing, { mode: 0o700 });
  const wrongOwner = await attempt(0, existing, { containerUid: me + 7 });
  await assert.rejects(wrongOwner.run, /owned by uid .* writes as uid/);
  assert.deepEqual(wrongOwner.chowned, [], "an existing foreign-owned directory is refused, never chowned");
});

test("the private root: a missing one is created owner-only, an existing one is reused with its data, and deploy, update and rollback all mount that same root", async () => {
  const w = world();
  const state = stateDir();
  const root = path.join(base, `fresh-${counter++}`, "nested", "reach-private");
  await deploy(opts(w, make("b1").dir, state, { privatePath: root }), w.deps);
  assert.equal(statSync(root).mode & 0o777, 0o700);
  writeFileSync(path.join(root, "config.json"), "{}");
  await deploy(opts(w, make("b2").dir, state, { privatePath: root }), w.deps);
  await rollback(opts(w, "", state, { privatePath: root }), w.deps);
  assert.equal(readFileSync(path.join(root, "config.json"), "utf8"), "{}", "the data is reused, never recreated");
  assert.deepEqual(w.log.map((l) => l.privatePath), [root, root, root]);
});

test("an unusable private root stops deploy and rollback before any Docker action: a file, or a directory owned by another uid", async () => {
  const w = world();
  const state = stateDir();
  writeState(state, JSON.stringify({ schema_version: 2, current: record("b2", null), previous: record("b1", null) }));
  const other = stateDir();
  for (const [label, extra, expected] of [["a file", { privatePath: NOT_A_DIR }, /not a usable directory/], ["another owner", { containerUid: process.getuid!() + 1 }, /owned by uid .* writes as uid/]] as [string, Partial<Options>, RegExp][]) {
    await assert.rejects(() => deploy(opts(w, make("b9").dir, other, extra), w.deps), expected, `deploy: ${label}`);
    await assert.rejects(() => rollback(opts(w, "", state, extra), w.deps), expected, `rollback: ${label}`);
  }
  assert.equal(w.log.length, 0, "compose never ran");
  assert.ok(!existsSync(path.join(other, "evidence.json")), "no evidence claims a deployment");
});

test("deploy and rollback refuse to switch a running deployment to another private root", async () => {
  const w = world();
  const state = stateDir();
  await deploy(opts(w, make("b1").dir, state), w.deps);
  await deploy(opts(w, make("b2").dir, state), w.deps);
  w.log.length = 0;
  const elsewhere = path.join(base, `elsewhere-${counter++}`);
  await assert.rejects(() => deploy(opts(w, make("b3").dir, state, { privatePath: elsewhere }), w.deps), /refusing to switch/);
  await assert.rejects(() => rollback(opts(w, "", state, { privatePath: elsewhere }), w.deps), /refusing to switch/);
  assert.equal(w.log.length, 0);
  assert.ok(!existsSync(elsewhere), "the other root was not even created");
});

test("bootstrap creates only the missing private root for the container user and deployer group, and a following deploy accepts it", async () => {
  const me = process.getuid!();
  const gid = process.getgid!();
  const root = path.join(base, `boot-${counter++}`);
  const prepare = () => bootstrapPrivateRoot({ privatePath: root, deployerGid: gid, containerUid: me }, { uid: () => 0 });
  assert.deepEqual(prepare(), { command: "bootstrap", private_path: root, result: "created", uid: me, gid, mode: "770" });
  writeFileSync(path.join(root, "config.json"), "{}");
  assert.equal(prepare().result, "ready");
  assert.equal(readFileSync(path.join(root, "config.json"), "utf8"), "{}");
  const w = world();
  assert.equal((await deploy(opts(w, make("b1").dir, stateDir(), { privatePath: root }), w.deps)).exit, 0);
});

test("bootstrap refuses an unprivileged caller, a missing parent and any unsuitable existing path, without changing it", () => {
  const me = process.getuid!();
  const gid = process.getgid!();
  const run = (root: string, extra: Partial<Options> = {}, uid = 0) => () => bootstrapPrivateRoot({ privatePath: root, deployerGid: gid, containerUid: me, ...extra }, { uid: () => uid });
  const missing = path.join(base, `boot-${counter++}`);
  assert.throws(run(missing, {}, 988), /must run as root/);
  assert.throws(run(path.join(missing, "nested")), /parent directory must already exist/);
  // A root that cannot be handed over is removed again instead of staying half prepared.
  if (me !== 0) assert.throws(run(missing, { containerUid: me + 7 }), /is not ready \(EPERM\)/);
  assert.ok(!existsSync(missing));
  const closed = path.join(base, `boot-${counter++}`);
  mkdirSync(closed, { mode: 0o700 });
  assert.throws(run(closed), /mode 700/);
  assert.throws(run(closed, { containerUid: me + 7 }), new RegExp(`expected owner ${me + 7}`));
  assert.throws(run(closed, { deployerGid: gid + 7 }), new RegExp(`group ${gid + 7} with`));
  assert.equal(statSync(closed).mode & 0o777, 0o700);
  const link = path.join(base, `boot-${counter++}`);
  symlinkSync(closed, link);
  assert.throws(run(link), /is not ready/);
  assert.throws(run(NOT_A_DIR), /is not ready/);
});

test("bootstrap arguments: a numeric deployer group and a private path are required, nothing else", () => {
  assert.deepEqual(parseArgs(["bootstrap", "--private-path", "/p", "--deployer-gid", "989"]), { command: "bootstrap", privatePath: "/p", deployerGid: 989 });
  assert.throws(() => parseArgs(["bootstrap", "--private-path", "/p"]), /missing --deployer-gid/);
  assert.throws(() => parseArgs(["bootstrap", "--private-path", "/p", "--deployer-gid", "runner"]), /numeric group id/);
  assert.throws(() => parseArgs(["bootstrap", "--private-path", "", "--deployer-gid", "1"]), /--private-path must not be empty/);
});
