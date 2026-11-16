// Production Server image assembly: structural contract (no Docker needed) plus the build helper driven with a stand-in docker.
// The real image build and container run are separate evidence; the real Server behind the entrypoint is proved in `npm run check:release`.
import { Buffer } from "node:buffer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { buildImage, stageContext } from "../deploy/prod/build-image.mjs";
import { LAYOUT, serverArgs } from "../deploy/prod/entrypoint.mjs";
import { buildManifest, REQUIRED_ARTIFACTS } from "../scripts/release/manifest.mjs";

const PROD = path.join(import.meta.dirname, "..", "deploy", "prod");
const text = (name) => readFileSync(path.join(PROD, name), "utf8");
const code = (name) => text(name).replace(/^\s*(#|\/\/).*$/gm, "");
const BUILD_ID = "prod-test-7";
const COMMIT = "c".repeat(40);
const base = mkdtempSync(path.join(tmpdir(), "reach-prod-"));

/** A small but valid canonical release: real manifest builder, stand-in archive bytes. */
function release(name = "rel") {
  const dir = path.join(base, name);
  mkdirSync(path.join(dir, "artifacts"), { recursive: true });
  mkdirSync(path.join(dir, "server"));
  const records = REQUIRED_ARTIFACTS.map((t) => {
    const fileName = `reach-${t.role}-${t.platform}.${t.os === "win32" ? "zip" : "tgz"}`;
    const bytes = Buffer.from(`${fileName} bytes`);
    writeFileSync(path.join(dir, t.role === "server" ? "server" : "artifacts", fileName), bytes);
    return { role: t.role, platform: t.platform, name: fileName, bytes };
  });
  writeFileSync(path.join(dir, "artifacts", "manifest.json"), JSON.stringify(buildManifest({ buildId: BUILD_ID, repositoryCommit: COMMIT, records })));
  return dir;
}

/** A stand-in docker that records its arguments and the context it was given. */
function fakeDocker() {
  const log = path.join(base, `docker-${readdirSync(base).length}.log`);
  const bin = `${log}.sh`;
  writeFileSync(bin, `#!/bin/sh\necho "$@" > "${log}"\nfor last; do :; done\nls -R "$last" >> "${log}"\necho "$last" > "${log}.ctx"\n`);
  chmodSync(bin, 0o755);
  return { bin, log };
}

test("the Dockerfile only wraps release bytes: no install/build/test, no source copy, no Git, non-root, labels from build args", () => {
  const df = code("Dockerfile");
  assert.doesNotMatch(df, /npm (ci|install|run)|\bgit\b|apt-get|curl|wget|COPY \.|COPY \.\.|ADD /i);
  assert.match(df, /^USER node$/m);
  assert.match(df, /COPY server\/runtime\.tgz/);
  assert.match(df, /COPY artifacts\/ \/opt\/reach\/artifacts\//);
  assert.match(df, /org\.opencontainers\.image\.version="\$\{REACH_BUILD_ID\}"/);
  assert.match(df, /org\.opencontainers\.image\.revision="\$\{REACH_REPOSITORY_COMMIT\}"/);
  assert.match(df, /^ENTRYPOINT \["node", "\/opt\/reach\/entrypoint\.mjs"\]$/m);
  assert.doesNotMatch(df, /reach-private|\/reach\/reach-|192\.168\.|\.lab\b/);
});

test("the entrypoint takes build id and commit from the baked manifest and runs the canonical launcher with the baked artifacts", () => {
  const dir = release("entry");
  const layout = { ...LAYOUT, artifacts: path.join(dir, "artifacts") };
  const args = serverArgs({}, layout);
  const flag = (name) => args[args.indexOf(`--${name}`) + 1];
  assert.equal(args[0], "/opt/reach/server/reach-server.mjs");
  assert.deepEqual([flag("build"), flag("repository-commit")], [BUILD_ID, COMMIT]);
  assert.deepEqual([flag("config"), flag("proposal"), flag("logs"), flag("artifacts")], ["/run/reach/config.json", "/run/reach/proposal.json", "/var/log/reach", layout.artifacts]);
  assert.deepEqual([flag("data-port"), flag("admin-port"), flag("data-host")], ["8787", "8788", "0.0.0.0"]);
  const custom = serverArgs({ REACH_DATA_PORT: "9001", REACH_ADMIN_PORT: "9002" }, layout);
  assert.deepEqual([custom[custom.indexOf("--data-port") + 1], custom[custom.indexOf("--admin-port") + 1]], ["9001", "9002"]);
  assert.ok(!/BUILD|COMMIT/.test(text("entrypoint.mjs").replace(/build_id|repository_commit|--build|--repository-commit/g, "")), "no build identity is read from the environment");
});

test("Compose runs a built image and mounts exactly config file, proposal file and log dir, with separate loopback ports and a restart policy", () => {
  const yaml = text("compose.yaml").replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(yaml, /^\s*build:/m, "Compose never builds from source");
  assert.match(yaml, /image: \$\{REACH_IMAGE:\?/);
  assert.match(yaml, /restart: unless-stopped/);
  const volumes = [...yaml.matchAll(/^\s+- (\$\{REACH_[A-Z_]+:\?[^}]*\}:[^\s]+)$/gm)].map((m) => m[1].split(":").pop());
  assert.deepEqual(volumes, ["/run/reach/config.json", "/run/reach/proposal.json", "/var/log/reach"]);
  assert.equal((yaml.match(/^\s+- \$\{REACH_[A-Z_]+:\?/gm) ?? []).length, 3, "no other mount");
  assert.doesNotMatch(yaml, /docker\.sock|privileged|network_mode: host|volumes:\s*\n\s*\w+:|\s- \/:|\s- \/\w+:\/\w+/);
  const ports = [...yaml.matchAll(/^\s+- "(\$\{REACH_(DATA|ADMIN)_BIND:-127\.0\.0\.1\}:\$\{REACH_\2_PORT:-\d+\}:(\d+))"$/gm)].map((m) => [m[2], m[3]]);
  assert.deepEqual(ports, [["DATA", "8787"], ["ADMIN", "8788"]], "data and admin are separate mappings, loopback by default");
});

test("the healthcheck probes the admin state endpoint without a credential and the image declares it", () => {
  const hc = code("healthcheck.mjs");
  assert.match(hc, /\/admin\/api\/state/);
  assert.doesNotMatch(hc, /Authorization|bearer|\/health\b|\/mcp/i);
  assert.match(text("Dockerfile"), /^HEALTHCHECK .*healthcheck\.mjs/m);
});

test("a verified release is staged to exactly the Dockerfile inputs, and docker gets the manifest's identity", () => {
  const dir = release("good");
  const { bin, log } = fakeDocker();
  const identity = buildImage({ releaseDir: dir, tag: "reach-server:test", docker: bin });
  assert.deepEqual(identity, { build_id: BUILD_ID, repository_commit: COMMIT });
  const call = readFileSync(log, "utf8");
  assert.match(call, new RegExp(`build --build-arg REACH_BUILD_ID=${BUILD_ID} --build-arg REACH_REPOSITORY_COMMIT=${COMMIT} -t reach-server:test `));
  for (const wanted of ["Dockerfile", "entrypoint.mjs", "healthcheck.mjs", "runtime.tgz", "manifest.json", "reach-client-linux-x64.tgz", "reach-client-win32-x64.zip"]) assert.ok(call.includes(wanted), wanted);
  assert.ok(!existsSync(readFileSync(`${log}.ctx`, "utf8").trim()), "the temporary context is removed");
  const context = mkdtempSync(path.join(base, "ctx-"));
  stageContext(dir, context);
  assert.deepEqual(readdirSync(context).sort(), ["Dockerfile", "artifacts", "entrypoint.mjs", "healthcheck.mjs", "server"]);
});

test("the Server archive is the one the manifest declares, staged under a neutral name; deploy/prod hardcodes no release filename", () => {
  const dir = release("declared");
  const context = mkdtempSync(path.join(base, "ctx-"));
  stageContext(dir, context);
  assert.deepEqual(readFileSync(path.join(context, "server", "runtime.tgz")), readFileSync(path.join(dir, "server", "reach-server-linux-x64.tgz")));
  assert.deepEqual(readdirSync(path.join(context, "server")), ["runtime.tgz"]);
  for (const name of ["Dockerfile", "build-image.mjs", "entrypoint.mjs", "healthcheck.mjs", "compose.yaml"]) assert.doesNotMatch(text(name), /reach-(server|client)-(linux|win32)/, name);
  const renamed = release("renamed");
  const m = JSON.parse(readFileSync(path.join(renamed, "artifacts", "manifest.json"), "utf8"));
  const rec = m.artifacts.find((a) => a.role === "server");
  renameSync(path.join(renamed, "server", rec.name), path.join(renamed, "server", "other-name.tgz"));
  rec.name = "other-name.tgz";
  writeFileSync(path.join(renamed, "artifacts", "manifest.json"), JSON.stringify(m));
  const ctx2 = mkdtempSync(path.join(base, "ctx-"));
  stageContext(renamed, ctx2);
  assert.ok(existsSync(path.join(ctx2, "server", "runtime.tgz")), "a renamed declared artifact is still found through the manifest");
});

test("a corrupted, missing or undeclared release stops before Docker is called", () => {
  const { bin, log } = fakeDocker();
  const corrupt = release("corrupt");
  writeFileSync(path.join(corrupt, "server", "reach-server-linux-x64.tgz"), "tampered");
  const undeclared = release("undeclared");
  writeFileSync(path.join(undeclared, "artifacts", "extra.bin"), "x");
  const missing = release("missing");
  writeFileSync(path.join(missing, "artifacts", "manifest.json"), "{}");
  for (const dir of [corrupt, undeclared, missing]) assert.throws(() => buildImage({ releaseDir: dir, tag: "t", docker: bin }), /release is not verified/);
  assert.ok(!existsSync(log), "docker was never invoked");
});

test("the CLI requires a release and a tag, and refuses a bad release with a non-zero exit", () => {
  const cli = path.join(PROD, "build-image.mjs");
  assert.equal(spawnSync(process.execPath, [cli], { encoding: "utf8" }).status, 2);
  const bad = spawnSync(process.execPath, [cli, "--release", path.join(base, "nowhere"), "--tag", "t"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /release is not verified/);
});

test("the production assets carry no self-update, downloader or private topology", () => {
  for (const name of ["Dockerfile", "entrypoint.mjs", "healthcheck.mjs", "compose.yaml", "build-image.mjs"]) {
    assert.doesNotMatch(text(name).replace(/^\s*(#|\/\/).*$/gm, ""), /curl|wget|auto-?update|watchtower|docker\.sock|reach-private|192\.168\.|\.lab\b/i, name);
  }
});
