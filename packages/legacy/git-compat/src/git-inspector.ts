// Temporary migration compatibility: read-only Git inspection (status, diff, log, show), ported from the Dev MCP.
// Disposable by design: this is the ONLY place in REACH that starts a subprocess, nothing in packages/shared imports it,
// and deleting packages/legacy/git-compat (plus its registration) removes the capability without touching core.
// `git` is started with execFile (no shell), a fixed subcommand per method, a sanitized environment and config
// overrides that disable anything a repository's own config could use to run code. Caller input is limited to a
// validated revision, lexically validated pathspecs after `--`, and bounded integers. Path policy and redaction
// are the shared owners' (path-policy, secret-policy); nothing is duplicated here.
import { execFile } from "node:child_process";
import { buildPathPolicy, FsError, HOST_PLATFORM, normalizeRelativePath, redactText, type PathPlatform, type PathPolicy } from "../../../shared/src/filesystem/index.ts";

const REV_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._/~^@{}:-]{0,99}$/;
/** maxBuffer is a multiple of the returned ceiling, so overflow can be told apart from routine output. */
const BUFFER_FACTOR = 4;
const SAFE_CONFIG = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.pager=cat", "-c", "diff.external=", "-c", "core.quotepath=false"];

export type GitLimits = {
  gitTimeoutMs: number;
  /** Largest output, in bytes, returned to the caller. */
  maxGitOutputBytes: number;
  maxGitLogCount: number;
};

export const DEFAULT_GIT_LIMITS: GitLimits = { gitTimeoutMs: 10_000, maxGitOutputBytes: 200_000, maxGitLogCount: 50 };

export type GitInspectorOptions = {
  /** Absolute repository root; every git call runs with `-C <root>`. */
  root: string;
  limits?: Partial<GitLimits>;
  /** Additive to the shared built-in deny list. */
  extraDenyGlobs?: string[];
  platform?: PathPlatform;
};

export type GitResult = { output: string; truncated: boolean };

/** Cuts text to at most `max` bytes without leaving a broken trailing character. */
function clipBytes(text: string, max: number): GitResult {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return { output: text, truncated: false };
  return { output: buf.subarray(0, max).toString("utf8").replace(/\uFFFD$/, ""), truncated: true };
}

export class GitInspector {
  private readonly root: string;
  private readonly limits: GitLimits;
  private readonly policy: PathPolicy;
  private readonly platform: PathPlatform;

  constructor(options: GitInspectorOptions) {
    this.root = options.root;
    this.platform = options.platform ?? HOST_PLATFORM;
    this.limits = { ...DEFAULT_GIT_LIMITS, ...options.limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isInteger(value) || value < 1) throw new FsError("INVALID_ARGUMENT", `git limit ${key} must be a positive integer`);
    }
    this.policy = buildPathPolicy(options.extraDenyGlobs);
  }

  /** Rejects anything that is not a plain revision: no leading `-`, no whitespace; `..` only as a simple range. */
  private rev(value: string, label: string): string {
    if (!REV_PATTERN.test(value) || (value.includes("..") && !/^[^.]+\.\.\.?[^.]+$/.test(value))) {
      throw new FsError("INVALID_ARGUMENT", `${label} is not a valid revision`);
    }
    return value;
  }

  /**
   * Lexical pathspec check only: a historical or deleted path must stay a valid filter, so nothing is resolved on disk.
   * Empty (the root itself) yields "".
   */
  private gitPath(input: string): string {
    const rel = normalizeRelativePath(input, this.platform);
    if (rel && this.policy.isDenied(rel)) throw new FsError("DENIED", "path is blocked by the filesystem security policy");
    return rel;
  }

  private wantedPaths(paths: string[] | undefined): string[] {
    return (paths ?? []).map((p) => this.gitPath(p)).filter(Boolean);
  }

  /** Excludes every denied path from diff/show output, so a committed secret file never reaches the caller. */
  private excludeSpecs(): string[] {
    return this.policy.denyGlobs.map((g) => `:(exclude,glob,icase)${g.includes("/") ? g : `**/${g}`}`);
  }

  private pathspecs(paths: string[] | undefined): string[] {
    const wanted = this.wantedPaths(paths);
    return ["--", ...(wanted.length > 0 ? wanted : ["."]), ...this.excludeSpecs()];
  }

  private run(args: string[]): Promise<GitResult> {
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_EXTERNAL_DIFF: "",
      LC_ALL: "C",
    };
    const max = this.limits.maxGitOutputBytes;
    return new Promise((resolve, reject) => {
      execFile("git", ["--no-pager", "-C", this.root, ...SAFE_CONFIG, ...args], { env, timeout: this.limits.gitTimeoutMs, maxBuffer: max * BUFFER_FACTOR, encoding: "utf8" }, (err, stdout, stderr) => {
        const overflow = (err as NodeJS.ErrnoException | null)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        if (err && !overflow) {
          // Only a fixed message or git's first stderr line with the root path masked; no raw stderr, no stack.
          const detail = (err as { killed?: boolean }).killed ? "git timed out" : stderr.split("\n")[0]?.replaceAll(this.root, "<root>") || "git failed";
          return reject(new FsError("INVALID_ARGUMENT", `git: ${detail}`));
        }
        const clipped = clipBytes(redactText(String(stdout)).text, max);
        resolve({ output: clipped.output, truncated: overflow || clipped.truncated });
      });
    });
  }

  async status(): Promise<{ branch: string | null; clean: boolean; entries: { status: string; path: string }[]; hiddenByPolicy: number }> {
    const { output } = await this.run(["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=normal"]);
    const parts = output.split("\0").filter(Boolean);
    let branch: string | null = null;
    const entries: { status: string; path: string }[] = [];
    let hidden = 0;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] as string;
      if (part.startsWith("## ")) {
        branch = part.slice(3);
        continue;
      }
      const status = part.slice(0, 2);
      const file = part.slice(3);
      if (status[0] === "R" || status[0] === "C") i++; // -z renames carry the origin as the next field
      if (this.policy.isDenied(file)) hidden++;
      else entries.push({ status, path: file });
    }
    return { branch, clean: entries.length === 0 && hidden === 0, entries, hiddenByPolicy: hidden };
  }

  diff(opts: { base?: string; head?: string; staged?: boolean; paths?: string[]; stat?: boolean }): Promise<GitResult> {
    const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
    if (opts.stat) args.push("--stat");
    if (opts.staged) args.push("--cached");
    if (opts.base) args.push(this.rev(opts.base, "base"));
    if (opts.head) {
      if (!opts.base) throw new FsError("INVALID_ARGUMENT", "head requires base");
      args.push(this.rev(opts.head, "head"));
    }
    return this.run([...args, ...this.pathspecs(opts.paths)]);
  }

  async log(opts: { rev?: string; count?: number; paths?: string[] }): Promise<{ commits: { hash: string; author: string; date: string; subject: string }[]; truncated: boolean }> {
    const count = Math.min(Math.max(opts.count ?? 20, 1), this.limits.maxGitLogCount);
    const args = ["log", `-n${count}`, "--no-color", "--format=%H%x1f%an%x1f%aI%x1f%s"];
    if (opts.rev) args.push(this.rev(opts.rev, "rev"));
    // Commit metadata carries no file content, so only caller-supplied paths limit the log; the default
    // exclude pathspecs would silently drop merge commits from the history.
    const wanted = this.wantedPaths(opts.paths);
    const { output, truncated } = await this.run([...args, ...(wanted.length > 0 ? ["--", ...wanted] : [])]);
    const commits = output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash = "", author = "", date = "", subject = ""] = line.split("\x1f");
        return { hash, author, date, subject };
      });
    return { commits, truncated };
  }

  /**
   * Header and patch are two calls on purpose: with a pathspec, git hides a commit entirely when it does not touch
   * the paths (merge commits are the usual case), so the metadata must never ride on the pathspec-limited call.
   */
  async show(opts: { rev: string; paths?: string[]; stat?: boolean }): Promise<GitResult> {
    const rev = this.rev(opts.rev, "rev");
    const header = await this.run(["show", "--no-patch", "--no-color", "--format=fuller", rev]);
    const flags = ["show", "--no-ext-diff", "--no-textconv", "--no-color", "--format="];
    if (opts.stat) flags.push("--stat");
    const body = await this.run([...flags, rev, ...this.pathspecs(opts.paths)]);
    const clipped = clipBytes(`${header.output.trimEnd()}\n\n${body.output}`.trimEnd() + "\n", this.limits.maxGitOutputBytes);
    return { output: clipped.output, truncated: header.truncated || body.truncated || clipped.truncated };
  }
}
