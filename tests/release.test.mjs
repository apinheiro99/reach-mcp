import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { collectEntries, tgz, zip } from "../scripts/release/archive.mjs";
import { selectClient } from "./release/select-client.mjs";
import { buildManifest, INSTALLERS, sha256, validateManifest } from "../scripts/release/manifest.mjs";

const COMMIT = "a".repeat(40);
const scratch = () => mkdtempSync(path.join(tmpdir(), "reach-release-unit-"));
const entries = [
  { path: "reach-x/b.txt", data: Buffer.from("bravo"), mode: 0o644 },
  { path: `reach-x/${"deep/".repeat(30)}file.ts`, data: Buffer.from("deep file"), mode: 0o755 },
];

const INSTALLER_BYTES = INSTALLERS.map(({ name }) => ({ name, bytes: Buffer.from(`${name} stand-in`) }));

test("tgz and zip: system tools extract the exact bytes, equal input gives equal archives", () => {
  const dir = scratch();
  writeFileSync(path.join(dir, "a.tgz"), tgz(entries));
  writeFileSync(path.join(dir, "a.zip"), zip(entries));
  assert.deepEqual(tgz(entries), tgz(entries));
  assert.deepEqual(zip(entries), zip(entries));
  mkdirSync(path.join(dir, "t"));
  mkdirSync(path.join(dir, "z"));
  execFileSync("tar", ["-xzf", path.join(dir, "a.tgz"), "-C", path.join(dir, "t")]);
  execFileSync("unzip", ["-q", path.join(dir, "a.zip"), "-d", path.join(dir, "z")]);
  for (const root of ["t", "z"]) {
    const got = collectEntries(path.join(dir, root)).map((e) => [e.path, e.data.toString(), e.mode]);
    assert.deepEqual(got, [["reach-x/b.txt", "bravo", 0o644], [`reach-x/${"deep/".repeat(30)}file.ts`, "deep file", 0o755]].sort((a, b) => (a[0] < b[0] ? -1 : 1)), root);
  }
});

test("a symlink is refused: an archive can never depend on one", () => {
  const dir = scratch();
  writeFileSync(path.join(dir, "real"), "x");
  symlinkSync(path.join(dir, "real"), path.join(dir, "link"));
  assert.throws(() => collectEntries(dir), /links are refused/);
});

test("manifest v2: one build id, exact compatibility, hashes from the final bytes; every incoherence is reported", () => {
  const bytes = Buffer.from("archive bytes");
  const records = [["server", "linux-x64", "reach-server-linux-x64.tgz"], ["client", "linux-x64", "reach-client-linux-x64.tgz"], ["client", "win32-x64", "reach-client-win32-x64.zip"]].map(([role, platform, name]) => ({ role, platform, name, bytes }));
  const m = buildManifest({ buildId: "rel-1", repositoryCommit: COMMIT, records, installers: INSTALLER_BYTES });
  assert.deepEqual(validateManifest(m), []);
  assert.deepEqual([m.release.build_id, m.server.build_id, m.client.build_id, m.compatibility], ["rel-1", "rel-1", "rel-1", { strategy: "exact", accepted_client_builds: ["rel-1"] }]);
  assert.deepEqual(m.artifacts[0], { role: "server", platform: "linux-x64", os: "linux", arch: "x64", name: "reach-server-linux-x64.tgz", sha256: sha256(bytes), size_bytes: bytes.length, download_path: null });
  assert.deepEqual(m.artifacts[2], { role: "client", platform: "win32-x64", os: "win32", arch: "x64", name: "reach-client-win32-x64.zip", sha256: sha256(bytes), size_bytes: bytes.length, download_path: "/release/artifacts/reach-client-win32-x64.zip" });
  const bad = (edit) => validateManifest(edit(JSON.parse(JSON.stringify(m))));
  assert.match(bad((x) => ((x.client.build_id = "other"), x)).join(), /same single build id/);
  assert.match(bad((x) => ((x.compatibility.accepted_client_builds = ["rel-1", "x"]), x)).join(), /accepted_client_builds/);
  assert.match(bad((x) => ((x.compatibility.strategy = "range"), x)).join(), /strategy/);
  assert.match(bad((x) => ((x.release.repository_commit = "abc"), x)).join(), /repository_commit/);
  assert.match(bad((x) => ((x.artifacts[0].sha256 = "ABC"), x)).join(), /sha256/);
  assert.match(bad((x) => ((x.artifacts[0].name = "../x"), x)).join(), /servable/);
  assert.match(bad((x) => ((x.schema_version = 1), x)).join(), /schema_version/);
  assert.match(bad((x) => ((x.artifacts = []), x)).join(), /non-empty/);
});

test("manifest v2 requires exactly server/linux-x64, client/linux-x64 and client/win32-x64: missing, duplicate and extra pairs are rejected", () => {
  const bytes = Buffer.from("x");
  const rec = (role, platform, name) => ({ role, platform, name, bytes });
  const all = [rec("server", "linux-x64", "s.tgz"), rec("client", "linux-x64", "c1.tgz"), rec("client", "win32-x64", "c2.zip")];
  const check = (records) => validateManifest(buildManifest({ buildId: "rel-1", repositoryCommit: COMMIT, records, installers: INSTALLER_BYTES }));
  assert.deepEqual(check(all), []);
  assert.match(check(all.filter((r) => r.platform !== "win32-x64")).join(), /required client\/win32-x64 is missing/);
  assert.match(check(all.filter((r) => !(r.role === "client" && r.platform === "linux-x64"))).join(), /required client\/linux-x64 is missing/);
  assert.match(check(all.filter((r) => r.role !== "server")).join(), /required server\/linux-x64 is missing/);
  assert.match(check([...all, rec("client", "win32-x64", "other-name.zip")]).join(), /client\/win32-x64 appears 2 times/);
  assert.match(check([...all, rec("client", "darwin-arm64", "c3.tgz")]).join(), /client\/darwin-arm64 is not part of manifest schema v2/);
  assert.match(check([...all, rec("tool", "linux-x64", "t.tgz")]).join(), /role must be server or client/);
});

test("the builder refuses a missing or invalid build id, a bad commit and a non-empty output directory before building anything", () => {
  const run = (...args) => spawnSync(process.execPath, ["scripts/release.mjs", ...args], { encoding: "utf8", cwd: path.join(import.meta.dirname, "..") });
  const out = path.join(scratch(), "o");
  assert.equal(run("build", "--out", out).status, 2);
  assert.match(run("build", "--out", out).stderr, /build-id/);
  assert.match(run("build", "--build-id", "", "--out", out).stderr, /build-id/);
  assert.match(run("build", "--build-id", "bad\nid", "--out", out).stderr, /build-id/);
  assert.match(run("build", "--build-id", "ok", "--repository-commit", "xyz", "--out", out).stderr, /40-hex/);
  const full = scratch();
  writeFileSync(path.join(full, "keep"), "x");
  assert.match(run("build", "--build-id", "ok", "--repository-commit", COMMIT, "--out", full).stderr, /absent or empty/);
});

test("manifest v2: an installer selects exactly one Client by os/arch and gets its relative path, hash and size; the Server is not advertised as public", () => {
  const records = [["server", "linux-x64", "s.tgz"], ["client", "linux-x64", "c-lin.tgz"], ["client", "win32-x64", "c-win.zip"]].map(([role, platform, name]) => ({ role, platform, name, bytes: Buffer.from(name) }));
  const m = buildManifest({ buildId: "rel-1", repositoryCommit: COMMIT, records, installers: INSTALLER_BYTES });
  assert.deepEqual(validateManifest(m), []);
  const lin = selectClient(m, "linux", "x64");
  const win = selectClient(m, "win32", "x64");
  assert.deepEqual([lin.download_path, lin.sha256, lin.size_bytes], ["/release/artifacts/c-lin.tgz", sha256(Buffer.from("c-lin.tgz")), 9]);
  assert.equal(win.download_path, "/release/artifacts/c-win.zip");
  assert.throws(() => selectClient(m, "darwin", "arm64"), /found 0/);
  assert.equal(m.artifacts.find((a) => a.role === "server").download_path, null);
  assert.ok(!JSON.stringify(m).includes("://"), "no origin or absolute URL in the manifest");
  const bad = (edit) => validateManifest(edit(JSON.parse(JSON.stringify(m)))).join();
  assert.match(bad((x) => ((x.artifacts[1].os = "win32"), x)), /os\/arch must be linux\/x64/);
  assert.match(bad((x) => ((x.artifacts[1].arch = "arm64"), x)), /os\/arch must be linux\/x64/);
  assert.match(bad((x) => (delete x.artifacts[1].os, x)), /os\/arch must be/);
  assert.match(bad((x) => ((x.artifacts[1].download_path = "http://host/release/artifacts/c-lin.tgz"), x)), /download_path must be \/release\/artifacts\/c-lin.tgz/);
  assert.match(bad((x) => ((x.artifacts[1].download_path = "/release/artifacts/../c-lin.tgz"), x)), /download_path must be/);
  assert.match(bad((x) => ((x.artifacts[1].download_path = "/release/artifacts/other.tgz"), x)), /download_path must be/);
  assert.match(bad((x) => (delete x.artifacts[1].download_path, x)), /download_path must be/);
  assert.match(bad((x) => ((x.artifacts[0].download_path = "/release/artifacts/s.tgz"), x)), /null \(not publicly served\)/);
});

test("manifest v2 declares the public installers: a missing, renamed, mispathed or unhashed installer is rejected", () => {
  const records = [["server", "linux-x64", "s.tgz"], ["client", "linux-x64", "c1.tgz"], ["client", "win32-x64", "c2.zip"]].map(([role, platform, name]) => ({ role, platform, name, bytes: Buffer.from(name) }));
  const m = buildManifest({ buildId: "rel-1", repositoryCommit: COMMIT, records, installers: INSTALLER_BYTES });
  assert.deepEqual(m.installers, [{ name: "install.sh", os: "linux", sha256: sha256(INSTALLER_BYTES[0].bytes), size_bytes: INSTALLER_BYTES[0].bytes.length, download_path: "/install.sh" }]);
  const bad = (edit) => validateManifest(edit(JSON.parse(JSON.stringify(m)))).join();
  assert.match(bad((x) => (delete x.installers, x)), /installers must list exactly install.sh/);
  assert.match(bad((x) => ((x.installers[0].name = "other.sh"), x)), /must be install.sh for linux/);
  assert.match(bad((x) => ((x.installers[0].download_path = "/release/artifacts/install.sh"), x)), /download_path must be \/install.sh/);
  assert.match(bad((x) => ((x.installers[0].sha256 = "x"), x)), /installers\[0\].sha256/);
  assert.match(bad((x) => ((x.installers[0].size_bytes = 0), x)), /installers\[0\].size_bytes/);
});
