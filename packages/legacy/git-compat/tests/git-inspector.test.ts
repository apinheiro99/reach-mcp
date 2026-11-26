// Parity and security tests for the temporary read-only Git inspection, on throwaway local repositories.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGitCompat, DEFAULT_GIT_LIMITS, GitInspector, type GitLimits } from "../src/index.ts";
import { FsError } from "@reach-mcp/shared/filesystem";

const here = import.meta.dirname;

function newRepo(prefix: string) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  return { root, git, put: (rel: string, data: string) => writeFileSync(path.join(root, rel), data) };
}

// Fixture values are plain markers; none is shaped like a real secret.
const main = newRepo("reach-git-");
const { root, git, put } = main;
mkdirSync(path.join(root, "src"));
put("src/a.ts", "export const a = 1;\n");
put(".env", "FIXTURE_VALUE=committed-marker\n");
git("add", "-A");
git("commit", "-q", "-m", "first commit");
put("src/a.ts", "export const a = 2;\n");
put(".env", "FIXTURE_VALUE=changed-marker\n");
git("add", "-A");
git("commit", "-q", "-m", "second commit");
// dirty state: unstaged edit, staged edit, untracked file, untracked denied file
put("src/a.ts", "export const a = 3;\n");
put("src/b.ts", "export const b = 1;\n");
git("add", "src/b.ts");
put("notes.txt", "untracked\n");
put(".env.staging", "X=untracked-marker\n");

const inspector = new GitInspector({ root });
const headBefore = git("rev-parse", "HEAD");

const refused = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
  } catch (err) {
    if (err instanceof FsError) return err.code;
    throw err;
  }
  return "NO_ERROR";
};

test("status: branch, staged/unstaged/untracked entries, denied files hidden but counted", async () => {
  const s = await inspector.status();
  assert.equal(s.branch?.startsWith("main"), true);
  assert.equal(s.clean, false);
  const byPath = Object.fromEntries(s.entries.map((e) => [e.path, e.status]));
  assert.equal(byPath["src/a.ts"], " M");
  assert.equal(byPath["src/b.ts"], "A ");
  assert.equal(byPath["notes.txt"], "??");
  assert.ok(!(".env.staging" in byPath), "a denied untracked file is not named");
  assert.equal(s.hiddenByPolicy, 1);
});

test("status: clean is false when only denied changes exist; renames carry their origin field", async () => {
  const only = newRepo("reach-git-hidden-");
  only.put("a.txt", "a\n");
  only.git("add", "-A");
  only.git("commit", "-q", "-m", "base");
  only.put(".env", "FIXTURE_VALUE=x\n");
  const hidden = await new GitInspector({ root: only.root }).status();
  assert.deepEqual(hidden.entries, []);
  assert.equal(hidden.hiddenByPolicy, 1);
  assert.equal(hidden.clean, false);

  only.git("mv", "a.txt", "b.txt");
  const renamed = await new GitInspector({ root: only.root }).status();
  assert.deepEqual(renamed.entries, [{ status: "R ", path: "b.txt" }], "the origin field is consumed, not listed as an entry");
});

test("diff: working tree, staged, revision range, stat and path filter", async () => {
  const wt = await inspector.diff({});
  assert.match(wt.output, /-export const a = 2;/);
  assert.match(wt.output, /\+export const a = 3;/);
  assert.match((await inspector.diff({ staged: true })).output, /src\/b\.ts/);
  const range = await inspector.diff({ base: "HEAD~1", head: "HEAD" });
  assert.match(range.output, /src\/a\.ts/);
  assert.ok(!range.output.includes("committed-marker") && !range.output.includes("changed-marker"), "a committed denied file never appears");
  assert.match((await inspector.diff({ base: "HEAD~1", stat: true })).output, /files? changed/);
  assert.equal((await inspector.diff({ paths: ["src/b.ts"] })).output, "", "path filter applies to the working tree diff");
});

test("log: bounded, structured, path filter, including a deleted historical path", async () => {
  const log = await inspector.log({});
  assert.deepEqual(log.commits.map((c) => c.subject), ["second commit", "first commit"]);
  assert.match(log.commits[0]?.hash ?? "", /^[0-9a-f]{40}$/);
  assert.equal((await inspector.log({ count: 1 })).commits.length, 1);
  assert.equal((await inspector.log({ paths: ["src/a.ts"] })).commits.length, 2);
  assert.equal((await inspector.log({ rev: "HEAD~1" })).commits.length, 1);
  const gone = newRepo("reach-git-gone-");
  gone.put("old.txt", "x\n");
  gone.git("add", "-A");
  gone.git("commit", "-q", "-m", "add old");
  gone.git("rm", "-q", "old.txt");
  gone.git("commit", "-q", "-m", "remove old");
  const hist = await new GitInspector({ root: gone.root }).log({ paths: ["old.txt"] });
  assert.equal(hist.commits.length, 2, "a path that no longer exists is still a valid filter");
});

test("show: commit patch without denied-file content; stat variant", async () => {
  const shown = await inspector.show({ rev: "HEAD" });
  assert.match(shown.output, /second commit/);
  assert.match(shown.output, /export const a = 2;/);
  assert.ok(!shown.output.includes("changed-marker") && !shown.output.includes("committed-marker"));
  assert.match((await inspector.show({ rev: "HEAD", stat: true })).output, /src\/a\.ts/);
});

test("merge commits stay visible in log and show", async () => {
  const m = newRepo("reach-git-merge-");
  m.put("base.txt", "base\n");
  m.git("add", "-A");
  m.git("commit", "-q", "-m", "base");
  m.git("checkout", "-q", "-b", "side");
  m.put("side.txt", "side\n");
  m.git("add", "-A");
  m.git("commit", "-q", "-m", "side commit");
  m.git("checkout", "-q", "main");
  m.put("main.txt", "main\n");
  m.git("add", "-A");
  m.git("commit", "-q", "-m", "main commit");
  m.git("merge", "-q", "--no-ff", "side", "-m", "merge side");
  const mi = new GitInspector({ root: m.root });
  assert.equal((await mi.log({})).commits[0]?.subject, "merge side");
  const shown = await mi.show({ rev: "HEAD", paths: ["side.txt"] });
  assert.match(shown.output, /merge side/);
  assert.match(shown.output, /Merge: /);
});

test("refuses option smuggling, shell metacharacters and denied or escaping paths", async () => {
  for (const bad of ["--output=/tmp/pwned", "-c", "--exec-path=/tmp", "HEAD; touch /tmp/pwned", "HEAD$(id)", "a b", "--", "../x"]) {
    assert.equal(await refused(() => inspector.show({ rev: bad })), "INVALID_ARGUMENT", `rev ${JSON.stringify(bad)}`);
    assert.equal(await refused(() => inspector.diff({ base: bad })), "INVALID_ARGUMENT");
    assert.equal(await refused(() => inspector.log({ rev: bad })), "INVALID_ARGUMENT");
  }
  assert.equal(await refused(() => inspector.show({ rev: "" })), "INVALID_ARGUMENT");
  assert.equal(await refused(() => inspector.diff({ head: "HEAD" })), "INVALID_ARGUMENT");
  assert.equal(await refused(() => inspector.diff({ paths: [".env"] })), "DENIED");
  assert.equal(await refused(() => inspector.log({ paths: ["config/server.pem"] })), "DENIED");
  assert.equal(await refused(() => inspector.show({ rev: "HEAD", paths: ["../outside"] })), "OUTSIDE_ROOT");
  assert.equal(await refused(() => inspector.show({ rev: "HEAD", paths: ["/etc/passwd"] })), "OUTSIDE_ROOT");
  assert.equal(await refused(() => inspector.show({ rev: "HEAD", paths: ["C:\\Windows\\win.ini"] })), "OUTSIDE_ROOT");
  assert.equal(await refused(() => inspector.show({ rev: "deadbeefdeadbeef" })), "INVALID_ARGUMENT", "unknown revision is a clean error");
  assert.ok(!existsSync("/tmp/pwned"));
});

test("errors never carry the repository root path", async () => {
  try {
    await inspector.show({ rev: "deadbeefdeadbeef" });
    assert.fail("expected a refusal");
  } catch (err) {
    assert.ok(!(err as Error).message.includes(root), "root path is masked");
  }
});

test("a repository's own config cannot run code through git inspection", async () => {
  const marker = path.join(root, "fsmonitor-ran");
  const hook = path.join(root, "fsmon.sh");
  writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  git("config", "core.fsmonitor", hook);
  git("config", "diff.external", hook);
  await inspector.status();
  await inspector.diff({});
  await inspector.show({ rev: "HEAD" });
  assert.equal(existsSync(marker), false);
  git("config", "--unset", "core.fsmonitor");
  git("config", "--unset", "diff.external");
});

test("inspection never mutates HEAD, the index or the working tree", async () => {
  const statusBefore = git("status", "--porcelain");
  const treeBefore = readFileSync(path.join(root, "src/a.ts"), "utf8");
  await inspector.status();
  await inspector.diff({ staged: true });
  await inspector.log({});
  await inspector.show({ rev: "HEAD" });
  assert.equal(git("rev-parse", "HEAD"), headBefore);
  assert.equal(git("status", "--porcelain"), statusBefore);
  assert.equal(readFileSync(path.join(root, "src/a.ts"), "utf8"), treeBefore);
});

test("limits are configurable: log count and output size are bounded with an explicit flag", async () => {
  const limits: Partial<GitLimits> = { maxGitLogCount: 1, maxGitOutputBytes: 120 };
  const small = new GitInspector({ root, limits });
  assert.equal((await small.log({ count: 50 })).commits.length, 1, "the configured ceiling wins over the request");
  const wt = await small.diff({});
  assert.equal(wt.truncated, true);
  assert.ok(Buffer.byteLength(wt.output) <= 120);
  assert.equal((await inspector.diff({})).truncated, false);
  assert.deepEqual(Object.keys(DEFAULT_GIT_LIMITS).sort(), ["gitTimeoutMs", "maxGitLogCount", "maxGitOutputBytes"]);
  assert.throws(() => new GitInspector({ root, limits: { gitTimeoutMs: 0 } }));
});

test("a git call that exceeds the timeout fails with a stable message", async () => {
  const bin = mkdtempSync(path.join(tmpdir(), "reach-fake-git-"));
  writeFileSync(path.join(bin, "git"), "#!/bin/sh\nsleep 5\n");
  chmodSync(path.join(bin, "git"), 0o755);
  const original = process.env.PATH;
  process.env.PATH = `${bin}:${original}`;
  try {
    const slow = new GitInspector({ root, limits: { gitTimeoutMs: 200 } });
    const started = Date.now();
    await assert.rejects(() => slow.status(), (err: unknown) => err instanceof FsError && err.code === "INVALID_ARGUMENT" && /timed out/.test(err.message));
    assert.ok(Date.now() - started < 4000, "the call was cut short");
  } finally {
    process.env.PATH = original;
  }
});

test("the module offers only read-only subcommands and no generic runner or shell", () => {
  const src = readFileSync(path.join(here, "../src/git-inspector.ts"), "utf8");
  const subcommands = [...src.matchAll(/\["([a-z]+)"[,\]]/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(subcommands)].sort(), ["diff", "log", "show", "status"]);
  for (const forbidden of ["commit", "add", "checkout", "reset", "clean", "stash", "push", "pull", "fetch", "merge", "rebase", "rm", "mv", "branch", "tag", "config", "apply"]) {
    assert.ok(!subcommands.includes(forbidden), `${forbidden} must not be a subcommand`);
  }
  assert.ok(!/shell\s*:/.test(src) && !/\bspawn\w*\(/.test(src) && !/\bexec\(/.test(src) && !/execSync/.test(src), "no shell, spawn or exec(string)");
  const publicMethods = Object.getOwnPropertyNames(GitInspector.prototype).filter((n) => n !== "constructor" && !["rev", "gitPath", "wantedPaths", "excludeSpecs", "pathspecs", "run"].includes(n));
  assert.deepEqual(publicMethods.sort(), ["diff", "log", "show", "status"]);
});

test("disable and removal boundary: disabled gives no inspector and core never imports git-compat", () => {
  assert.equal(createGitCompat({ enabled: false, root }), null);
  assert.ok(createGitCompat({ enabled: true, root }) instanceof GitInspector);
  const sharedSrc = path.join(here, "../../../shared/src");
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? walk(path.join(dir, n)) : [path.join(dir, n)]));
  for (const file of walk(sharedSrc)) {
    const text = readFileSync(file, "utf8");
    assert.ok(!/git-compat|packages\/legacy/.test(text), `${file} must not reference the legacy module`);
    assert.ok(!/node:child_process/.test(text), `${file} must not start subprocesses`);
  }
  // the legacy package only reaches into shared through its public filesystem entry, never through a relative path
  const own = readFileSync(path.join(here, "../src/git-inspector.ts"), "utf8");
  assert.deepEqual([...own.matchAll(/from "(@reach-mcp\/[^"]+)"/g)].map((m) => m[1]), ["@reach-mcp/shared/filesystem"]);
  assert.deepEqual([...own.matchAll(/from "(\.\.[^"]*)"/g)].map((m) => m[1]), []);
});

test("a project owned by another user is inspected, trusting only the configured root", { skip: process.platform === "win32" }, async () => {
  // Git's own test switch makes every repository look foreign; a PATH shim sets it because the child env is sanitized.
  const shimDir = mkdtempSync(path.join(tmpdir(), "reach-git-shim-"));
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const shim = path.join(shimDir, "git");
  writeFileSync(shim, `#!/bin/sh\nGIT_TEST_ASSUME_DIFFERENT_OWNER=1 exec "${realGit}" "$@"\n`);
  chmodSync(shim, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${shimDir}${path.delimiter}${originalPath}`;
  try {
    assert.throws(() => execFileSync("git", ["-C", root, "status"], { env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdio: "pipe" }), /dubious ownership/);
    assert.equal((await new GitInspector({ root }).status()).branch?.startsWith("main"), true);
    // A subdirectory as root does not extend trust to the repository above it.
    await assert.rejects(new GitInspector({ root: path.join(root, "src") }).status(), /dubious ownership/);
  } finally {
    process.env.PATH = originalPath;
  }
});
