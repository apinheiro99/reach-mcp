// Path policy: lexical normalisation (Linux and Windows forms), the deny list and root containment. Pure functions,
// so the Windows rules are testable on any host. The built-in deny rules are a floor: extra globs only add to them.
import path from "node:path";
import { FsError } from "./errors.ts";

export type PathPlatform = "posix" | "win32";
export const HOST_PLATFORM: PathPlatform = process.platform === "win32" ? "win32" : "posix";

/** Directories never entered by recursive tools (noise, not secrets). Still readable when asked for by path. */
export const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "__pycache__", ".cache", "dist", "build", "coverage"]);

const BUILTIN_DENY_GLOBS = [
  ".git/**",
  "**/.git/**",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.jks",
  "**/*.keystore",
  "**/*.kdbx",
  "**/id_rsa*",
  "**/id_dsa*",
  "**/id_ecdsa*",
  "**/id_ed25519*",
  "**/.ssh/**",
  "**/.gnupg/**",
  "**/.aws/**",
  "**/.azure/**",
  "**/.kube/**",
  "**/.docker/config.json",
  "**/.npmrc",
  "**/.pypirc",
  "**/.netrc",
  "**/.pgpass",
  "**/.git-credentials",
  "**/credentials",
  "**/credentials.*",
  "**/*.credentials",
  "**/secrets",
  "**/secrets.*",
  "**/secret",
  "**/secret.*",
  "**/*.secret",
  "**/*.secrets",
  "**/service-account*.json",
  "**/client_secret*.json",
  "**/token.json",
  "**/tokens.json",
  "**/*.db",
  "**/*.sqlite",
  "**/*.sqlite3",
  "**/*.db-wal",
  "**/*.db-shm",
];

/** `.env` family: denied, except explicit templates which hold names, not values. */
const ENV_GLOBS = ["**/.env", "**/.env.*", "**/*.env"];
const ENV_TEMPLATE_BASENAME = /^(?:\.env\.(?:example|sample|template|dist|defaults?)|(?:example|sample|template)\.env|\.env\.[a-z0-9_-]+\.(?:example|sample|template))$/i;

const regexCache = new Map<string, RegExp>();

/** Glob to RegExp over a posix relative path. `**` crosses `/`, `*` and `?` do not. Case-insensitive. */
export function globToRegExp(glob: string): RegExp {
  const cached = regexCache.get(glob);
  if (cached) return cached;
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const compiled = new RegExp(`^${re}$`, "i");
  regexCache.set(glob, compiled);
  return compiled;
}

export type PathPolicy = { isDenied(relPath: string): boolean; denyGlobs: string[] };

export function buildPathPolicy(extraDenyGlobs: string[] = []): PathPolicy {
  const base = [...BUILTIN_DENY_GLOBS, ...extraDenyGlobs].map(globToRegExp);
  const env = ENV_GLOBS.map(globToRegExp);
  return {
    denyGlobs: [...BUILTIN_DENY_GLOBS, ...ENV_GLOBS, ...extraDenyGlobs],
    isDenied(relPath: string): boolean {
      const basename = relPath.slice(relPath.lastIndexOf("/") + 1);
      const patterns = ENV_TEMPLATE_BASENAME.test(basename) ? base : [...base, ...env];
      // `dir/` is tested too so a `**/.ssh/**` rule also denies the directory entry itself, not only its children.
      return patterns.some((re) => re.test(relPath) || re.test(`${relPath}/`));
    },
  };
}

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9])$/i;

/**
 * Lexical normalisation of a user path to a relative posix path with no `..`, no NUL and no absolute form; "" is the
 * root. Backslashes are separators on every platform. Drive-letter, UNC and extended-length forms are outside the
 * root. On win32 the NTFS forms that alias another name are refused or collapsed before the deny rules see them:
 * alternate data streams, reserved device names, and trailing dots/spaces (`.env.` is `.env`).
 */
export function normalizeRelativePath(input: string, platform: PathPlatform = HOST_PLATFORM): string {
  if (input.includes("\0")) throw new FsError("INVALID_ARGUMENT", "path contains a NUL byte");
  const posix = input.replaceAll("\\", "/");
  if (posix.startsWith("/") || /^[A-Za-z]:\//.test(posix) || (platform === "win32" && /^[A-Za-z]:/.test(posix))) {
    throw new FsError("OUTSIDE_ROOT", "paths must be relative to the project root");
  }
  const normalized = path.posix.normalize(posix === "" ? "." : posix);
  if (normalized === ".." || normalized.startsWith("../")) throw new FsError("OUTSIDE_ROOT", "path escapes the project root");
  const rel = normalized === "." ? "" : normalized.replace(/\/$/, "");
  if (platform !== "win32" || rel === "") return rel;
  const segments = rel.split("/").map((segment) => {
    if (segment.includes(":")) throw new FsError("INVALID_ARGUMENT", "NTFS alternate data stream syntax is not permitted");
    const collapsed = segment.replace(/[. ]+$/, "");
    if (collapsed === "") throw new FsError("INVALID_ARGUMENT", "path segment is empty after Windows normalisation");
    if (WINDOWS_DEVICE_NAME.test(collapsed.split(".")[0] as string)) throw new FsError("INVALID_ARGUMENT", "reserved Windows device name is not permitted");
    return collapsed;
  });
  return segments.join("/");
}

/** True when `abs` is `root` or inside it. win32 comparison is case-insensitive and understands drive/UNC forms. */
export function isInsideRoot(root: string, abs: string, platform: PathPlatform = HOST_PLATFORM): boolean {
  const p = platform === "win32" ? path.win32 : path.posix;
  const rel = p.relative(root, abs);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel);
}
