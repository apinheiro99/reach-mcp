// GitHub publication is owned by CI: one script pushes the exact tested SHA to main (lease-protected) and its green tag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { greenTag, publish, type Git } from "../scripts/git-ci/publish-github.ts";

const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" };
const sh = (cwd: string, ...args: string[]): string => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENTITY } });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const gitIn = (cwd: string): Git => (args, env) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENTITY, ...env } });
  if (r.status !== 0) throw new Error(r.stderr.trim());
  return r.stdout.trim();
};

const TAG = "v2026.11.000042";
const CREATED = "2026-11-23T10:00:00Z";

/** A job checkout (with the GitLab origin holding the green tag), an empty GitHub bare repo and the host-local private root. */
function scene() {
  const root = mkdtempSync(path.join(tmpdir(), "reach-publish-"));
  const origin = path.join(root, "origin.git");
  const github = path.join(root, "github.git");
  const work = path.join(root, "work");
  const priv = path.join(root, "private");
  sh(root, "init", "--bare", "-b", "main", origin);
  sh(root, "init", "--bare", "-b", "main", github);
  sh(root, "init", "-b", "main", work);
  sh(work, "remote", "add", "origin", origin);
  writeFileSync(path.join(work, "a.txt"), "one");
  sh(work, "add", "."); sh(work, "commit", "-m", "one");
  const sha = sh(work, "rev-parse", "HEAD");
  sh(work, "tag", TAG, sha); sh(work, "push", "origin", "main", `refs/tags/${TAG}`);
  mkdirSync(path.join(priv, "credentials", "github"), { recursive: true });
  mkdirSync(path.join(priv, "config"), { recursive: true });
  const key = path.join(priv, "credentials", "github", "reach-mcp");
  writeFileSync(key, "not-a-real-key-content");
  writeFileSync(path.join(priv, "config", "github.env"), `# host-local\nREACH_GITHUB_OWNER=acme\nREACH_GITHUB_REPO=reach\nREACH_GITHUB_REPOSITORY="${github}"\n`);
  const env = { CI_COMMIT_SHA: sha, CI_PIPELINE_CREATED_AT: CREATED, CI_PIPELINE_IID: "42", REACH_PRIVATE_PATH: priv };
  return { root, origin, github, work, priv, key, sha, env, git: gitIn(work) };
}

test("the green tag has exactly the grammar of the CI tag job, never -fail", () => {
  assert.equal(greenTag(CREATED, "42"), TAG);
  assert.equal(greenTag("2026-01-31T23:59:59Z", "7"), "v2026.01.000007");
  assert.doesNotMatch(greenTag(CREATED, "42"), /-fail/);
});

test("first publication: main did not exist, the tested SHA and its green tag are published", () => {
  const s = scene();
  const out = publish(s.env, s.git);
  assert.equal(out.tag, TAG);
  assert.equal(sh(s.github, "rev-parse", "refs/heads/main"), s.sha);
  assert.equal(sh(s.github, "rev-parse", `refs/tags/${TAG}^{commit}`), s.sha);
  assert.equal(out.lease, "refs/heads/main:");
});

test("normal update: an existing main is advanced to the tested SHA under a lease bound to the observed ref", () => {
  const s = scene();
  const first = s.sha;
  sh(s.work, "push", s.github, `${first}:refs/heads/main`);
  writeFileSync(path.join(s.work, "a.txt"), "two");
  sh(s.work, "commit", "-am", "two");
  const second = sh(s.work, "rev-parse", "HEAD");
  sh(s.work, "tag", "v2026.11.000043", second); sh(s.work, "push", "origin", "refs/tags/v2026.11.000043");
  const out = publish({ ...s.env, CI_COMMIT_SHA: second, CI_PIPELINE_IID: "43" }, s.git);
  assert.equal(out.lease, `refs/heads/main:${first}`);
  assert.equal(sh(s.github, "rev-parse", "refs/heads/main"), second);
  assert.equal(sh(s.github, "rev-parse", "refs/tags/v2026.11.000043^{commit}"), second);
});

test("an unexpected remote advance makes the lease fail instead of overwriting, and no tag is published", () => {
  const s = scene();
  sh(s.work, "push", s.github, `${s.sha}:refs/heads/main`);
  writeFileSync(path.join(s.work, "a.txt"), "two");
  sh(s.work, "commit", "-am", "two");
  const second = sh(s.work, "rev-parse", "HEAD");
  sh(s.work, "tag", "v2026.11.000043", second); sh(s.work, "push", "origin", "refs/tags/v2026.11.000043");
  // someone else advances GitHub main between the observation and the push
  const racing: Git = (args, env) => {
    const out = s.git(args, env);
    if (args[0] === "ls-remote") {
      const other = path.join(s.root, "other");
      sh(s.root, "clone", s.github, other);
      writeFileSync(path.join(other, "b.txt"), "x");
      sh(other, "add", "."); sh(other, "commit", "-m", "elsewhere"); sh(other, "push", "origin", "main");
    }
    return out;
  };
  const remoteBefore = sh(s.github, "rev-parse", "refs/heads/main");
  assert.throws(() => publish({ ...s.env, CI_COMMIT_SHA: second, CI_PIPELINE_IID: "43" }, racing));
  assert.notEqual(sh(s.github, "rev-parse", "refs/heads/main"), second);
  assert.notEqual(sh(s.github, "rev-parse", "refs/heads/main"), remoteBefore, "the other party's commit is still there");
  assert.equal(spawnSync("git", ["rev-parse", "--verify", "refs/tags/v2026.11.000043"], { cwd: s.github }).status !== 0, true, "no tag after a failed main push");
});

test("the tag must exist on origin and point at the tested SHA; nothing is pushed otherwise", () => {
  const s = scene();
  assert.throws(() => publish({ ...s.env, CI_PIPELINE_IID: "99" }, s.git), /./);
  assert.equal(spawnSync("git", ["rev-parse", "--verify", "refs/heads/main"], { cwd: s.github }).status !== 0, true);
  sh(s.work, "tag", "v2026.11.000044", s.sha);
  writeFileSync(path.join(s.work, "a.txt"), "three");
  sh(s.work, "commit", "-am", "three");
  const other = sh(s.work, "rev-parse", "HEAD");
  sh(s.work, "push", "origin", "refs/tags/v2026.11.000044");
  assert.throws(() => publish({ ...s.env, CI_COMMIT_SHA: other, CI_PIPELINE_IID: "44" }, s.git), /not the tested commit/);
});

test("credentials come only from the private root and a missing key or config fails without echoing values", () => {
  const s = scene();
  writeFileSync(path.join(s.priv, "config", "github.env"), "REACH_GITHUB_OWNER=secretowner\n");
  assert.throws(() => publish(s.env, s.git), (e: Error) => /REACH_GITHUB_REPO/.test(e.message) && !/secretowner/.test(e.message));
  const t = scene();
  writeFileSync(path.join(t.priv, "config", "github.env"), "");
  assert.throws(() => publish(t.env, t.git), /REACH_GITHUB_OWNER/);
  const u = scene();
  chmodSync(u.key, 0o600);
  assert.throws(() => publish({ ...u.env, REACH_PRIVATE_PATH: path.join(u.root, "nowhere") }, u.git), /missing/);
  assert.throws(() => publish({ ...u.env, REACH_PRIVATE_PATH: "" }, u.git), /REACH_PRIVATE_PATH/);
});

test("SSH uses only the private key with strict host policy, and the lease is never a bare force", () => {
  const s = scene();
  const calls: { args: string[]; ssh: string | undefined }[] = [];
  const spy: Git = (args, env) => { calls.push({ args, ssh: env?.GIT_SSH_COMMAND }); return s.git(args, env); };
  publish(s.env, spy);
  const remote = calls.filter((c) => c.ssh !== undefined);
  assert.ok(remote.length >= 3, "ls-remote, main push and tag push go through the private key");
  for (const c of remote) assert.match(c.ssh as string, /-o IdentitiesOnly=yes/);
  for (const c of remote) assert.doesNotMatch(c.ssh as string, /StrictHostKeyChecking=no|UserKnownHostsFile=\/dev\/null/);
  const push = calls.find((c) => c.args[0] === "push" && c.args.some((a) => a.startsWith("--force-with-lease=")));
  assert.ok(push, "main is pushed with an explicit lease");
  for (const c of calls) assert.ok(!c.args.includes("--force") && !c.args.includes("-f") && !c.args.includes("--force-with-lease"), "no bare force");
  const tagPush = calls.find((c) => c.args[0] === "push" && c.args.some((a) => a.startsWith("refs/tags/")));
  assert.ok(tagPush && !tagPush.args.some((a) => a.includes("force")), "the tag is pushed without force");
});

test("run as a script without the pipeline variables, it fails with a clear message and exit 1", () => {
  const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "scripts", "git-ci", "publish-github.ts")], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /CI_COMMIT_SHA/);
});
