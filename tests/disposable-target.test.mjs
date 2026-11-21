// The disposable Linux target (deploy/dev/disposable-linux-target.sh): create, isolate, install the canonical Client artifact with its
// default paths, reach a real Server and enroll, recreate clean and destroy leaving nothing. Needs unprivileged user namespaces; when the
// host has none the lifecycle test is skipped with that reason instead of failing.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { parseServerArgs, startServer } from "../packages/server/src/runtime.ts";

const REPO = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO, "deploy", "dev", "disposable-linux-target.sh");
const INSTALLER = path.join(REPO, "deploy", "client", "install-linux.sh");
const base = mkdtempSync(path.join(tmpdir(), "reach-targets-"));
after(() => rmSync(base, { recursive: true, force: true }));
const { fetch } = globalThis;
const env = { ...process.env, REACH_TARGET_ROOT: base, REACH_HOST_ONLY_MARKER: "present-on-host" };
const harness = (...args) => execFileSync("bash", [SCRIPT, ...args], { encoding: "utf8", env }).trim();
const inside = (name, ...cmd) => harness("run", name, "--", ...cmd);
const tryHarness = (...args) => spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env });

const namespaces = spawnSync("unshare", ["--map-root-user", "--mount", "--pid", "--fork", "true"]).status === 0;
const skip = namespaces ? false : "unprivileged user/mount/PID namespaces are not available on this host";

test("names are validated: nothing but the fixed prefix and six characters ever reaches a path or a kill", () => {
  for (const bad of ["", "../x", "reach-target-", "reach-target-../..", "reach-target-abcdefg", "other-abcdef", "/tmp"]) {
    for (const sub of ["destroy", "status", "put"]) {
      const r = tryHarness(sub, bad, "/etc/hostname");
      assert.notEqual(r.status, 0, `${sub} ${bad}`);
    }
  }
  assert.notEqual(tryHarness("run", "reach-target-abcdef", "--", "true").status, 0, "an unknown target is refused");
  assert.equal(tryHarness().status, 2, "no subcommand prints the usage and exits 2");
});

test("lifecycle: fresh and isolated, canonical artifact installs with default paths, a Client enrolls against a real Server, recreation is clean, destroy leaves nothing", { skip, timeout: 280_000 }, async () => {
  const release = path.join(base, "release");
  execFileSync(process.execPath, [path.join(REPO, "scripts", "release.mjs"), "build", "--build-id", "dev-1", "--repository-commit", "0".repeat(40), "--out", release], { encoding: "utf8" });
  const archive = path.join(release, "artifacts", "reach-client-linux-x64.tgz");
  const hostOpt = existsSync("/opt/reach-mcp-client");
  const hostUnits = existsSync("/etc/systemd/system/reach-mcp-client.service");

  const name = harness("create");
  assert.match(name, /^reach-target-[A-Za-z0-9]{6}$/);
  const dir = path.join(base, name);
  assert.deepEqual(harness("status").split("\n"), [name]);
  const listing = () => readdirSync(dir, { recursive: true }).join("\n");
  assert.ok(!/identity|bootstrap/i.test(listing()), "a fresh target holds no Client identity or bootstrap");

  // Isolation: no host home, checkout or share, no host environment, the Node prefix read-only.
  assert.equal(inside(name, "sh", "-c", "echo ${REACH_HOST_ONLY_MARKER:-unset}"), "unset");
  assert.equal(inside(name, "sh", "-c", "ls -A /home"), "reach");
  for (const hidden of ["/scope", "/reach", "/root"]) {
    assert.equal(inside(name, "sh", "-c", `[ ! -d ${hidden} ] || ls -A ${hidden} | wc -l`).replace(/^$/, "0"), "0", `${hidden} is empty inside`);
  }
  assert.notEqual(spawnSync("bash", [SCRIPT, "run", name, "--", "sh", "-c", "touch /usr/local/probe"], { env }).status, 0, "the Node prefix is read-only");
  assert.match(inside(name, "node", "--version"), /^v(2[4-9]|[3-9]\d)\./, "the Client machine prerequisite, Node >= 24, is present");

  // Install the real release artifact with the installer's own defaults.
  const root = "/mnt/root";
  mkdirSync(path.join(dir, "stage", "root"));
  harness("put", name, archive);
  harness("put", name, INSTALLER);
  const server = await startServer(parseServerArgs(["--config", path.join(base, "cfg", "config.json"), "--proposal", path.join(base, "cfg", "proposal.json"), "--logs", path.join(base, "logs"), "--port", "0", "--admin-port", "0", "--build", "dev-1"]));
  try {
    const bootstrapSource = path.join(base, "bootstrap.env");
    writeFileSync(bootstrapSource, `REACH_SERVER_URL=ws://127.0.0.1:${server.port}/client\nREACH_ROOTS=${JSON.stringify([root])}\n`, { mode: 0o600 });
    harness("put", name, bootstrapSource);
    inside(name, "bash", "/mnt/install-linux.sh", "--archive", "/mnt/reach-client-linux-x64.tgz", "--bootstrap", "/mnt/bootstrap.env", "--build", "dev-1", "--allow-insecure-ws");
    assert.ok(existsSync(path.join(dir, "opt", "reach-mcp-client", "reach-client.mjs")), "installed under the target's /opt");
    assert.ok(existsSync(path.join(dir, "units", "reach-mcp-client.service")), "the unit was written under the target's /etc/systemd/system");
    assert.equal(existsSync("/opt/reach-mcp-client"), hostOpt, "the host install directory is untouched");
    assert.equal(existsSync("/etc/systemd/system/reach-mcp-client.service"), hostUnits, "the host unit directory is untouched");
    assert.ok(!readFileSync(path.join(dir, "stage", "bootstrap.env"), "utf8").includes("REACH_CLIENT_IDENTITY_KEY"), "no identity before the Client first runs");

    // The installed Client reaches the real Server service plane and registers itself.
    const admin = `http://127.0.0.1:${server.adminPort}`;
    const bearer = "disposable-bearer-" + "Hq48Tz21";
    assert.equal((await fetch(`${admin}/admin/api/config`, { method: "PUT", body: JSON.stringify({ mcp_bearer: bearer, clients: [] }) })).status, 200);
    const connected = async () => (await (await fetch(`http://127.0.0.1:${server.port}/health`, { headers: { Authorization: `Bearer ${bearer}` } })).json()).clients.connected;
    const waitFor = async (n) => {
      for (let i = 0; i < 160 && (await connected()) !== n; i++) await sleep(50);
      return connected();
    };
    const pid = harness("run", name, "--detach", "--", "node", "/opt/reach-mcp-client/reach-client.mjs", "--bootstrap", "/mnt/bootstrap.env", "--build", "dev-1", "--allow-insecure-ws");
    assert.match(pid, /^\d+$/);
    const listed = async () => (await (await fetch(`${admin}/admin/api/clients`)).json()).clients;
    for (let i = 0; i < 160 && (await listed()).length === 0; i++) await sleep(50);
    const [registered] = await listed();
    assert.equal(registered?.status, "pending", "the Client inside the target registered itself and waits for a human");
    assert.equal(await connected(), 0, "Pending has no session");
    assert.equal((await fetch(`${admin}/admin/api/clients/${encodeURIComponent(registered.client_id)}/enable`, { method: "POST" })).status, 200);
    assert.equal(await waitFor(1), 1, "after the human Enable the Client inside the target connected to the Server");
    assert.equal(harness("status", name), `${name} running=1`);
    const generated = readFileSync(path.join(dir, "stage", "bootstrap.env"), "utf8");
    assert.match(generated, /REACH_CLIENT_IDENTITY_KEY=\S+/, "the identity was generated inside the target only");
    const identityText = /REACH_CLIENT_IDENTITY_KEY=(\S+)/.exec(generated)[1];
    assert.ok(!readFileSync(path.join(base, "cfg", "config.json"), "utf8").includes(identityText), "the Server never saw the private key");

    // Teardown kills what runs inside and removes every trace, the identity included.
    assert.match(harness("destroy", name), /^destroyed /);
    assert.equal(await waitFor(0), 0, "the Client stopped with its target");
    assert.ok(!existsSync(dir), "the target directory is gone");
    assert.equal(harness("status"), "", "no target remains");
    assert.ok(!readdirSync(base).some((f) => f.startsWith("reach-target-")), "nothing was left under the target root");
    assert.equal(existsSync("/opt/reach-mcp-client"), hostOpt);
  } finally {
    await server.stop();
  }

  // Recreation starts clean: a new target, no identity, none of the previous state.
  const again = harness("create");
  assert.notEqual(again, name);
  assert.ok(!/identity|bootstrap|reach-mcp-client/i.test(readdirSync(path.join(base, again), { recursive: true }).join("\n")), "the recreated target is empty");
  harness("destroy", again);
  assert.equal(harness("status"), "");
});
