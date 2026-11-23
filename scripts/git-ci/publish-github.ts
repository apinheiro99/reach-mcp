// CI-owned GitHub publication: pushes the exact tested commit to GitHub main and its green pipeline tag.
// Credentials and the GitHub coordinates live only under the host-local private root (REACH_PRIVATE_PATH); nothing is tracked or echoed.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

/** Runs one git command in the job checkout and returns its trimmed stdout; throws with git's stderr on failure. */
export type Git = (args: string[], env?: NodeJS.ProcessEnv) => string;

const MAIN = "refs/heads/main";
const GREEN_TAG = /^v\d{4}\.\d{2}\.\d{6}$/;
const KEY_PATH = ["credentials", "github", "reach-mcp"];
const CONFIG_PATH = ["config", "github.env"];

/** Same grammar and inputs as the green tag job and Build Release in .gitlab-ci.yml: vYYYY.MM.NNNNNN. */
export function greenTag(createdAt: string, iid: string): string {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) throw new Error("CI_PIPELINE_CREATED_AT is not a date");
  const month = String(created.getUTCMonth() + 1).padStart(2, "0");
  return `v${created.getUTCFullYear()}.${month}.${iid.padStart(6, "0")}`;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

/** Reads KEY=VALUE lines (comments and surrounding quotes allowed); the file is data, never executed. */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1] as string] = (m[2] as string).replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

function githubRepository(privateRoot: string): { key: string; repository: string } {
  const key = path.join(privateRoot, ...KEY_PATH);
  const config = path.join(privateRoot, ...CONFIG_PATH);
  if (!existsSync(key)) throw new Error(`missing GitHub deploy key under the private root: ${KEY_PATH.join("/")}`);
  if (!existsSync(config)) throw new Error(`missing GitHub config under the private root: ${CONFIG_PATH.join("/")}`);
  const values = parseEnvFile(readFileSync(config, "utf8"));
  const need = (name: string) => {
    const value = values[name];
    if (!value) throw new Error(`${name} must be set in the private ${CONFIG_PATH.join("/")}`);
    return value;
  };
  const owner = need("REACH_GITHUB_OWNER");
  const repo = values["REACH_GITHUB_REPO"] || "reach-mcp";
  return { key, repository: values["REACH_GITHUB_REPOSITORY"] || `git@github.com:${owner}/${repo}.git` };
}

/** Publishes CI_COMMIT_SHA to GitHub main (lease bound to the observed remote main) and then its green tag. */
export function publish(env: NodeJS.ProcessEnv, git: Git): { tag: string; lease: string } {
  const sha = required(env, "CI_COMMIT_SHA");
  const tag = greenTag(required(env, "CI_PIPELINE_CREATED_AT"), required(env, "CI_PIPELINE_IID"));
  if (!GREEN_TAG.test(tag)) throw new Error("only a green pipeline tag is published");
  const { key, repository } = githubRepository(required(env, "REACH_PRIVATE_PATH"));

  // The tag exists on GitLab only if the green tag job succeeded; it must point at the tested commit.
  git(["fetch", "--no-tags", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
  if (git(["rev-parse", `refs/tags/${tag}^{commit}`]) !== sha) throw new Error(`tag ${tag} is not the tested commit`);

  chmodSync(key, 0o600);
  const ssh = { GIT_SSH_COMMAND: `ssh -i '${key}' -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new` };
  const observed = git(["ls-remote", repository, MAIN], ssh).split(/\s+/)[0] ?? "";
  const lease = `${MAIN}:${observed}`;
  git(["push", `--force-with-lease=${lease}`, repository, `${sha}:${MAIN}`], ssh);
  git(["push", repository, `refs/tags/${tag}:refs/tags/${tag}`], ssh);
  return { tag, lease };
}

const systemGit: Git = (args, env) => {
  const r = spawnSync("git", args, { encoding: "utf8", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
};

if (import.meta.main) {
  try {
    const { tag } = publish(process.env, systemGit);
    console.log(`published ${tag} and its commit to GitHub main`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
