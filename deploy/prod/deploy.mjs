// Controlled production delivery for the canonical release: one transaction around build-image.mjs and compose.yaml. It runs ON the
// deployment host; the host, credentials and paths are operator inputs (flags / environment), never defaults of this repository.
//   node deploy/prod/deploy.mjs deploy   --release <dir> --state <dir> --private-path <dir> --admin-bind <addr> --admin-allow-from <addr-or-cidr,...> [options]
//   node deploy/prod/deploy.mjs rollback --state <dir> --private-path <dir> --admin-bind <addr> --admin-allow-from <list> ... (uses the recorded previous deployment)
//   node deploy/prod/deploy.mjs status   --state <dir>
// The Server's whole persistent state (configuration, proposal, logs) lives under ONE host directory, --private-path, mounted at /reach-private.
// State (<state>/state.json) keeps two known-good deployments, `current` and `previous`, each: build_id, repository_commit, image,
// private_path (a path only, never contents), deployed_at. A candidate becomes `current` only after the Server answers healthy,
// reports exactly the candidate's build id and commit, and the smoke checks pass; the switch is one atomic rename.
import { execFileSync } from "node:child_process";
import { accessSync, closeSync, constants, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleepMs } from "node:timers/promises";
import { MANIFEST_NAME, SERVED_DIR, verifyRelease } from "../../scripts/release/manifest.mjs";
import { buildImage } from "./build-image.mjs";

const COMPOSE_FILE = path.join(import.meta.dirname, "compose.yaml");
const STATE_FILE = "state.json";
const LOCK_FILE = "deploy.lock";
const STATE_SCHEMA = 2;
/** The node user of the production image: it writes the private root. */
export const CONTAINER_UID = 1000;

const text = (v) => typeof v === "string" && v !== "";

/** Problems of one persisted deployment record (empty = valid). */
const recordProblems = (name, r) =>
  r === null
    ? []
    : typeof r !== "object" || Array.isArray(r)
      ? [`${name} must be a record or null`]
      : [
          ...["build_id", "image", "deployed_at"].filter((k) => !text(r[k])).map((k) => `${name}.${k} must be a non-empty string`),
          ...(r.private_path === null || text(r.private_path) ? [] : [`${name}.private_path must be a non-empty string or null`]),
          ...(/^[0-9a-f]{40}$/.test(r.repository_commit) ? [] : [`${name}.repository_commit must be a 40-hex commit`]),
        ];

/** Fail closed: only a missing state file means "first deployment"; anything unreadable, malformed or unsupported stops the command. */
const readState = (dir) => {
  const file = path.join(dir, STATE_FILE);
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { schema_version: STATE_SCHEMA, current: null, previous: null };
    throw new Error(`deployment state ${file} cannot be read (${error.code ?? error.message}): refusing to continue`, { cause: error });
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch (error) {
    throw new Error(`deployment state ${file} is not valid JSON: refusing to continue, it is not repaired automatically`, { cause: error });
  }
  // Schema 1 recorded separate config and proposal paths; schema 2 records the one private root (unknown for a migrated record).
  if (state !== null && typeof state === "object" && state.schema_version === 1) {
    const migrate = (r) => {
      if (r === null || typeof r !== "object" || Array.isArray(r)) return r;
      const next = { ...r, private_path: null };
      delete next.config;
      delete next.proposal;
      return next;
    };
    state = { ...state, schema_version: STATE_SCHEMA, current: migrate(state.current), previous: migrate(state.previous) };
  }
  const problems =
    state === null || typeof state !== "object"
      ? ["the state must be an object"]
      : [...(state.schema_version === STATE_SCHEMA ? [] : [`unsupported schema_version ${JSON.stringify(state.schema_version)}`]), ...recordProblems("current", state.current), ...recordProblems("previous", state.previous)];
  if (problems.length > 0) throw new Error(`deployment state ${file} is invalid: refusing to continue\n${problems.join("\n")}`);
  return state;
};

function writeStateAtomic(dir, state) {
  const tmp = path.join(dir, `${STATE_FILE}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path.join(dir, STATE_FILE));
}

/** One deployment at a time: the lock file is created exclusively and removed when the command ends. */
async function withLock(dir, fn) {
  const lock = path.join(dir, LOCK_FILE);
  try {
    closeSync(openSync(lock, "wx"));
  } catch {
    throw new Error(`another deployment is running or was interrupted (${lock} exists): refusing to start`);
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

const defaultDeps = () => ({
  run: (cmd, args, env) => execFileSync(cmd, args, { env: { ...process.env, ...env }, stdio: "inherit" }),
  http: async (url) => {
    const res = await globalThis.fetch(url, { signal: globalThis.AbortSignal.timeout(4000) });
    return { status: res.status, body: await res.text() };
  },
  sleep: (ms) => sleepMs(ms),
  now: () => new Date().toISOString(),
});

/** Docker turns a missing bind-mount source into a root-owned directory and the Server then silently starts in setup mode: refuse that before anything runs. */
function assertInputFiles(opts) {
  const wrongKind = (file, kind) => {
    try {
      return !statSync(file)[kind]();
    } catch {
      return true;
    }
  };
  const bad = [["tunnel-binary", opts.tunnelBinary, "isFile"], ["tunnel-dir", opts.tunnelDir, "isDirectory"]].filter(([, file, kind]) => wrongKind(file, kind));
  if (bad.length > 0) throw new Error(`deployment input is missing or of the wrong kind (${bad.map(([name]) => name).join(", ")}): provision it before deploying`);
}

/**
 * The one private root of the Server: an existing directory is reused, a missing one is created (owner only), anything else stops the command before Docker.
 * The container writes it as CONTAINER_UID, so a root that user cannot write is refused instead of widened with chmod or replaced by container-local storage.
 */
function ensurePrivateRoot(opts) {
  const root = opts.privatePath;
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
    accessSync(root, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch (error) {
    throw new Error(`the private root ${root} is not a usable directory (${error.code ?? error.message}): nothing was started`, { cause: error });
  }
  const owner = statSync(root).uid;
  const expected = opts.containerUid ?? CONTAINER_UID;
  if (owner !== expected) throw new Error(`the private root ${root} is owned by uid ${owner} but the Server container writes as uid ${expected}: fix the owner, nothing was started`);
}

/** A running deployment keeps its private root: moving it is a deliberate migration, not a side effect of a deploy or rollback. */
function assertSamePrivateRoot(opts, record) {
  if (record !== null && record.private_path !== null && record.private_path !== opts.privatePath) {
    throw new Error(`the current deployment uses private root ${record.private_path}, not ${opts.privatePath}: refusing to switch it`);
  }
}

/** Compose is the only runtime definition; the deployment only chooses the image and the external inputs. */
function apply(deps, opts, d) {
  deps.run(opts.docker, ["compose", "-p", opts.project, "-f", COMPOSE_FILE, "up", "-d"], {
    REACH_IMAGE: d.image, REACH_PRIVATE_PATH: opts.privatePath,
    REACH_PORT: String(opts.port), REACH_ADMIN_PORT: String(opts.adminPort),
    REACH_ADMIN_BIND: opts.adminBind, REACH_ADMIN_ALLOW_FROM: opts.adminAllowFrom,
    REACH_TUNNEL_BINARY: opts.tunnelBinary, REACH_TUNNEL_DIR: opts.tunnelDir,
  });
}

/** Health, running identity and smoke for one deployment. Returns { ok, checks[] } with no secret material. */
async function verify(deps, opts, d) {
  const checks = [];
  // Readiness and running identity come from the service plane's public release manifest (baked into the running image), never from the Admin plane,
  // whose direct-peer allowlist is deployment policy and must not depend on how a probe reaches the container.
  const manifest = `http://127.0.0.1:${opts.port}/release/manifest`;
  let health = null;
  for (let i = 0; i < opts.retries && health === null; i++) {
    try {
      const res = await deps.http(manifest);
      if (res.status === 200) health = JSON.parse(res.body).release ?? null;
    } catch {
      /* not up yet */
    }
    if (health === null) await deps.sleep(opts.intervalMs);
  }
  checks.push({ name: "health", ok: health !== null });
  const identity = health !== null && health.build_id === d.build_id && health.repository_commit === d.repository_commit;
  checks.push({ name: "running-identity", ok: identity, ...(health === null ? {} : { running_build: health.build_id, running_commit: health.repository_commit }) });
  // The data-plane /health is bearer-protected: 401 proves an active configuration is enforcing it; 503 means no active configuration (setup mode).
  const smoke = await deps.http(`http://127.0.0.1:${opts.port}/health`).then((res) => res.status, () => 0);
  checks.push({ name: "smoke-data-plane", ok: smoke > 0 && smoke < 500, data_plane_status: smoke });
  return { ok: checks.every((c) => c.ok), checks };
}

const brief = (d) => (d === null ? null : { build_id: d.build_id, repository_commit: d.repository_commit, image: d.image });

async function restore(deps, opts, d) {
  try {
    apply(deps, opts, d);
    return (await verify(deps, opts, d)).ok ? "restored" : "restore-unhealthy";
  } catch {
    return "restore-failed";
  }
}

function finish(dir, evidencePath, deps, evidence) {
  const full = { schema_version: STATE_SCHEMA, finished_at: deps.now(), ...evidence };
  writeFileSync(evidencePath ?? path.join(dir, "evidence.json"), `${JSON.stringify(full, null, 2)}\n`);
  return full;
}

export async function deploy(opts, deps = defaultDeps()) {
  mkdirSync(opts.state, { recursive: true });
  return withLock(opts.state, async () => {
    const started_at = deps.now();
    const problems = verifyRelease(opts.release);
    if (problems.length > 0) throw new Error(`release is not verified, nothing is deployed:\n${problems.join("\n")}`);
    const { release } = JSON.parse(readFileSync(path.join(opts.release, SERVED_DIR, MANIFEST_NAME), "utf8"));
    const image = `${opts.imageRepo}:${release.build_id}`;
    const candidate = { build_id: release.build_id, repository_commit: release.repository_commit, image, private_path: opts.privatePath, deployed_at: null };
    const state = readState(opts.state);
    const previousGood = state.current;
    assertSamePrivateRoot(opts, previousGood);
    ensurePrivateRoot(opts);
    const report = { command: "deploy", started_at, candidate: brief(candidate), previous_known_good: brief(previousGood) };
    let outcome;
    try {
      assertInputFiles(opts);
      buildImage({ releaseDir: opts.release, tag: image, docker: opts.docker });
      apply(deps, opts, candidate);
      outcome = await verify(deps, opts, candidate);
    } catch (error) {
      outcome = { ok: false, checks: [{ name: "apply", ok: false, error: error.message.split("\n")[0] }] };
    }
    if (outcome.ok) {
      candidate.deployed_at = deps.now();
      writeStateAtomic(opts.state, { schema_version: STATE_SCHEMA, current: candidate, previous: previousGood });
      return { exit: 0, evidence: finish(opts.state, opts.evidence, deps, { ...report, result: "promoted", checks: outcome.checks }) };
    }
    const rollback = previousGood === null ? "no-previous-known-good" : await restore(deps, opts, previousGood);
    return { exit: 1, evidence: finish(opts.state, opts.evidence, deps, { ...report, result: "candidate-failed", checks: outcome.checks, rollback }) };
  });
}

export async function rollback(opts, deps = defaultDeps()) {
  mkdirSync(opts.state, { recursive: true });
  return withLock(opts.state, async () => {
    const started_at = deps.now();
    const state = readState(opts.state);
    if (state.previous === null) throw new Error("there is no previous known-good deployment: nothing to roll back to");
    const target = state.previous;
    assertSamePrivateRoot(opts, state.current);
    ensurePrivateRoot(opts);
    const report = { command: "rollback", started_at, from: brief(state.current), to: brief(target) };
    const result = await restore(deps, opts, target);
    if (result !== "restored") return { exit: 1, evidence: finish(opts.state, opts.evidence, deps, { ...report, result }) };
    writeStateAtomic(opts.state, { schema_version: STATE_SCHEMA, current: { ...target, private_path: opts.privatePath, deployed_at: deps.now() }, previous: state.current });
    return { exit: 0, evidence: finish(opts.state, opts.evidence, deps, { ...report, result: "restored" }) };
  });
}

export const status = (opts) => readState(opts.state);

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith("--") || rest[i + 1] === undefined) throw new Error(`bad argument ${rest[i]}`);
    flags[rest[i].slice(2)] = rest[i + 1];
  }
  const need = (name) => {
    if (flags[name] === undefined) throw new Error(`missing --${name}`);
    return flags[name];
  };
  const opts = {
    state: path.resolve(need("state")), docker: flags.docker ?? "docker", project: flags.project ?? "reach", imageRepo: flags["image-repo"] ?? "reach-server",
    port: Number(flags.port ?? 8787), adminPort: Number(flags["admin-port"] ?? 8788),
    retries: Number(flags.retries ?? 30), intervalMs: Number(flags["interval-ms"] ?? 2000), ...(flags.evidence === undefined ? {} : { evidence: path.resolve(flags.evidence) }),
  };
  const tunnel = () => ({ tunnelBinary: path.resolve(need("tunnel-binary")), tunnelDir: path.resolve(need("tunnel-dir")) });
  // The Admin exposure and the private root are deployment policy: every command that applies Compose names them, an unset CI variable (empty value) is refused, and there is no default.
  const policy = () => {
    for (const name of ["admin-bind", "admin-allow-from", "private-path"]) if (need(name) === "") throw new Error(`--${name} must not be empty`);
    return { adminBind: flags["admin-bind"], adminAllowFrom: flags["admin-allow-from"], privatePath: path.resolve(flags["private-path"]) };
  };
  if (command === "deploy") return { command, ...opts, release: path.resolve(need("release")), ...tunnel(), ...policy() };
  if (command === "rollback") return { command, ...opts, ...tunnel(), ...policy() };
  if (command === "status") return { command, ...opts };
  throw new Error("usage: deploy.mjs deploy|rollback|status --state <dir> ...");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.command === "status") process.stdout.write(`${JSON.stringify(status(opts), null, 2)}\n`);
    else {
      const { exit, evidence } = await (opts.command === "deploy" ? deploy(opts) : rollback(opts));
      process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
      process.exit(exit);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
}
