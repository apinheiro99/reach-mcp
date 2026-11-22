// The one release builder. One invocation takes ONE opaque build id and the repository commit and writes, under --out:
//   artifacts/manifest.json, artifacts/install.sh, artifacts/reach-client-linux-x64.tgz, artifacts/reach-client-win32-x64.zip   (what the Server serves)
//   server/reach-server-linux-x64.tgz                                                                       (the Server runtime input)
// Each archive is a self-contained Node >=24 runtime: the REACH packages as ordinary directories under lib/, the production
// dependency tree installed by npm, and a thin launcher. No workspace link, no Git metadata, no dev dependency, no test.
//   node scripts/release.ts build --build-id <id> [--repository-commit <sha>] --out <dir>
//   node scripts/release.ts verify --out <dir>
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { collectEntries, tgz, zip, type ArchiveEntry } from "./release/archive.ts";
import { artifactDir, buildManifest, INSTALLERS, MANIFEST_NAME, parseBuildId, parseCommit, REQUIRED_ARTIFACTS, SERVED_DIR, SERVER_DIR, verifyRelease, type Role, type Untrusted } from "./release/manifest.ts";

const REPO = path.resolve(import.meta.dirname, "..");
/** The Windows Client carries its own Node runtime so a fresh machine needs no Node. Pinned version and the SHA-256 Node publishes for this exact file
 *  (SHASUMS256.txt of that release); the builder refuses any other bytes. It is part of the Windows archive, so the manifest hash already covers it. */
const WINDOWS_NODE = { version: "26.13.1", url: "https://nodejs.org/dist/v26.13.1/win-x64/node.exe", sha256: "f5109dc868ec38703ad8f305e0aceece717cb60d4889873f434017af4e96cccb" };
/** package name -> source directory. The closure of each role is derived from its package.json dependencies. */
const PACKAGES: Record<string, string> = {
  "@reach-mcp/shared": "packages/shared",
  "@reach-mcp/git-compat": "packages/legacy/git-compat",
  "@reach-mcp/client": "packages/client",
  "@reach-mcp/server": "packages/server",
};
/** The canonical role/platform set comes from the manifest owner; only the archive format and file name are decided here. */
type Target = (typeof REQUIRED_ARTIFACTS)[number] & { archive: (entries: ArchiveEntry[]) => Buffer; name: string };
const TARGETS: Target[] = REQUIRED_ARTIFACTS.map((t) => (t.os === "win32" ? { ...t, archive: zip, name: `reach-${t.role}-${t.platform}.zip` } : { ...t, archive: tgz, name: `reach-${t.role}-${t.platform}.tgz` }));

const readJson = (file: string): Untrusted => JSON.parse(readFileSync(file, "utf8"));
const manifestOf = (name: string) => readJson(path.join(REPO, PACKAGES[name] ?? "", "package.json"));

/** The REACH packages a role needs: itself plus its local dependencies, transitively. */
function closure(role: Role) {
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const dep of Object.keys(manifestOf(name).dependencies ?? {})) if (dep in PACKAGES) visit(dep);
  };
  visit(`@reach-mcp/${role}`);
  return [...seen].sort();
}

/** The pinned node.exe, downloaded once into a cache and verified against the pinned SHA-256 every time it is used. */
function windowsNode() {
  const cached = path.join(tmpdir(), "reach-node-cache", `node-${WINDOWS_NODE.version}-win-x64.exe`);
  const verified = () => existsSync(cached) && createHash("sha256").update(readFileSync(cached)).digest("hex") === WINDOWS_NODE.sha256;
  if (!verified()) {
    mkdirSync(path.dirname(cached), { recursive: true });
    execFileSync("curl", ["-fsSL", "--max-time", "600", "-o", cached, WINDOWS_NODE.url], { stdio: ["ignore", "ignore", "inherit"] });
    if (!verified()) {
      rmSync(cached, { force: true });
      throw new Error(`release: the downloaded node.exe ${WINDOWS_NODE.version} does not match the pinned SHA-256`);
    }
  }
  return cached;
}

function stage(target: Target, buildDir: string) {
  const root = path.join(buildDir, `${target.role}-${target.platform}`, `reach-${target.role}`);
  mkdirSync(path.join(root, "lib"), { recursive: true });
  const locals = closure(target.role);
  const dependencies: Record<string, string> = {};
  for (const name of locals) {
    const dest = path.join(root, "lib", name.replace("@reach-mcp/", ""));
    cpSync(path.join(REPO, PACKAGES[name] ?? "", "src"), path.join(dest, "src"), { recursive: true, filter: (src) => path.basename(src) !== "testing" });
    copyFileSync(path.join(REPO, PACKAGES[name] ?? "", "package.json"), path.join(dest, "package.json"));
    for (const [dep, range] of Object.entries(manifestOf(name).dependencies ?? {}) as [string, string][]) if (!(dep in PACKAGES)) dependencies[dep] = range;
  }
  writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: `reach-${target.role}-runtime`, version: "0.0.0", private: true, type: "module", engines: { node: ">=24" }, dependencies }, null, 2)}\n`);
  copyFileSync(path.join(REPO, "package-lock.json"), path.join(root, "package-lock.json")); // pins the versions npm resolves
  execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", `--os=${target.os}`, "--cpu=x64"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  rmSync(path.join(root, "node_modules", ".bin"), { recursive: true, force: true });
  rmSync(path.join(root, "node_modules", ".package-lock.json"), { force: true });
  // The launcher is TypeScript source; the artifact keeps its external JavaScript name (reach-client.mjs / reach-server.mjs), generated by stripping types.
  writeFileSync(path.join(root, `reach-${target.role}.mjs`), stripTypeScriptTypes(readFileSync(path.join(import.meta.dirname, "release", "launcher.ts"), "utf8")));
  copyFileSync(path.join(REPO, "LICENSE"), path.join(root, "LICENSE"));
  if (target.role === "client" && target.os === "linux") {
    // The public install.sh runs this low-level installer out of the verified archive: it stays the one owner of the swap and the unit.
    mkdirSync(path.join(root, "deploy"));
    copyFileSync(path.join(REPO, "deploy", "client", "install-linux.sh"), path.join(root, "deploy", "install-linux.sh"));
    copyFileSync(path.join(REPO, "deploy", "client", "uninstall-linux.sh"), path.join(root, "deploy", "uninstall-linux.sh"));
  }
  if (target.role === "client" && target.os === "win32") {
    mkdirSync(path.join(root, "deploy"));
    copyFileSync(path.join(REPO, "deploy", "client", "install-windows.ps1"), path.join(root, "deploy", "install-windows.ps1"));
    copyFileSync(path.join(REPO, "deploy", "client", "uninstall-windows.ps1"), path.join(root, "deploy", "uninstall-windows.ps1"));
    mkdirSync(path.join(root, "runtime"));
    copyFileSync(windowsNode(), path.join(root, "runtime", "node.exe"));
  }
  return root;
}

export function build({ buildId, repositoryCommit, out }: { buildId: string; repositoryCommit: string; out: string }) {
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`release: --out ${out} must be absent or empty`);
  const work = mkdtempSync(path.join(tmpdir(), "reach-release-"));
  try {
    const records = TARGETS.map((target) => {
      const entries = collectEntries(stage(target, work)).map((e) => ({ ...e, path: `reach-${target.role}/${e.path}` }));
      return { role: target.role, platform: target.platform, name: target.name, bytes: target.archive(entries) };
    });
    mkdirSync(path.join(out, SERVED_DIR), { recursive: true });
    mkdirSync(path.join(out, SERVER_DIR), { recursive: true });
    const installers = INSTALLERS.map(({ name }) => ({ name, bytes: readFileSync(path.join(REPO, "deploy", "client", name)) }));
    for (const i of installers) writeFileSync(path.join(out, SERVED_DIR, i.name), i.bytes);
    for (const r of records) writeFileSync(path.join(out, artifactDir(r.role), r.name), r.bytes);
    writeFileSync(path.join(out, SERVED_DIR, MANIFEST_NAME), `${JSON.stringify(buildManifest({ buildId, repositoryCommit, records, installers }), null, 2)}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const problems = verifyRelease(out);
  if (problems.length > 0) throw new Error(`release: the produced layout failed verification: ${problems.join("; ")}`);
}

function option(args: string[], name: string) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  try {
    const outArg = option(args, "--out");
    if (outArg === undefined) throw new Error("release: --out <dir> is required");
    const out = path.resolve(outArg);
    if (command === "build") {
      const buildId = parseBuildId(option(args, "--build-id"));
      const repositoryCommit = parseCommit(option(args, "--repository-commit") ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).trim());
      build({ buildId, repositoryCommit, out });
      process.stdout.write(`release: ${buildId} written to ${out}\n`);
    } else if (command === "verify") {
      const problems = verifyRelease(out);
      if (problems.length > 0) throw new Error(`release: verification failed:\n  ${problems.join("\n  ")}`);
      process.stdout.write("release: verified, every artifact matches the manifest\n");
    } else {
      throw new Error("usage: node scripts/release.ts build --build-id <id> [--repository-commit <sha>] --out <dir> | verify --out <dir>");
    }
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(2);
  }
}
