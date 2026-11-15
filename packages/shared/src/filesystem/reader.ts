// Root-confined, read-only filesystem access: list, find, bounded read, search and image read. In-process fs reads
// only: no subprocess, no write. Every public method takes a user path RELATIVE to the project root.
//
// Symlinks are never followed. A direct operation that meets one refuses (SYMLINK_REFUSED); list, find and search
// skip symlink entries without traversing them. On Windows, Node reports junctions as symbolic links, so the same
// rule covers junctions and reparse points that Node can see.
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { FsError } from "./errors.ts";
import { IMAGE_EXT, imageDimensions, sniffImage, type ImageMime } from "./image.ts";
import { type FsLimits, resolveLimits } from "./limits.ts";
import { buildPathPolicy, globToRegExp, HOST_PLATFORM, isInsideRoot, normalizeRelativePath, SKIP_DIRS, type PathPlatform, type PathPolicy } from "./path-policy.ts";
import { hasPrivateKey, redactText } from "./secret-policy.ts";

export type FsReaderOptions = {
  /** Absolute project root. */
  root: string;
  limits?: Partial<FsLimits>;
  /** Additive to the built-in deny list; can never remove a built-in rule. */
  extraDenyGlobs?: string[];
  /** Path rules to apply; defaults to the host platform. */
  platform?: PathPlatform;
};

export type SearchOptions = {
  patterns: string[];
  mode?: "text" | "regex";
  caseSensitive?: boolean;
  path?: string;
  include?: string[];
  exclude?: string[];
  contextLines?: number;
  limit?: number;
};

export type SearchMatch = { pattern: string; path: string; line: number; text: string; before?: string[]; after?: string[] };
export type Entry = { path: string; type: "file" | "dir"; size?: number };

export const BINARY_SNIFF_BYTES = 8192;
/** A quantified group that is itself quantified, e.g. (a+)+ or (.*)*: the classic catastrophic-backtracking shape. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/;

export class FilesystemReader {
  readonly root: string;
  private readonly limits: FsLimits;
  private readonly policy: PathPolicy;
  private readonly platform: PathPlatform;

  constructor(options: FsReaderOptions) {
    this.platform = options.platform ?? HOST_PLATFORM;
    this.root = realpathSync(options.root);
    if (!statSync(this.root).isDirectory()) throw new FsError("INVALID_ARGUMENT", "root is not a directory");
    this.limits = resolveLimits(options.limits);
    this.policy = buildPathPolicy(options.extraDenyGlobs);
  }

  get denyGlobs(): string[] {
    return this.policy.denyGlobs;
  }

  isDenied(rel: string): boolean {
    return this.policy.isDenied(rel);
  }

  /**
   * Resolves a user path to a real absolute path inside the root. The deny policy runs on the lexical path BEFORE any
   * filesystem access (so denied paths look the same whether or not they exist); then every component is checked
   * with lstat so a symlink anywhere on the way is refused rather than followed; finally the realpath must still be
   * inside the root and not denied (explicit mount points are allowed, redirection by symlink is not).
   */
  resolve(input: string): { rel: string; abs: string } {
    const rel = normalizeRelativePath(input, this.platform);
    if (rel && this.policy.isDenied(rel)) throw new FsError("DENIED", "path is blocked by the filesystem security policy");
    let current = this.root;
    for (const segment of rel === "" ? [] : rel.split("/")) {
      current = path.join(current, segment);
      let stat;
      try {
        stat = lstatSync(current, { throwIfNoEntry: false });
      } catch {
        stat = undefined;
      }
      if (!stat) throw new FsError("NOT_FOUND", `no such path: ${rel || "."}`);
      if (stat.isSymbolicLink()) {
        throw new FsError("SYMLINK_REFUSED", "path is or passes through a symlink; access through symlinks is not permitted. Expose the real target as its own project root instead");
      }
    }
    let real: string;
    try {
      real = realpathSync(current);
    } catch {
      throw new FsError("NOT_FOUND", `no such path: ${rel || "."}`);
    }
    if (!isInsideRoot(this.root, real, this.platform)) throw new FsError("OUTSIDE_ROOT", "path resolves outside the project root");
    const realRel = path.relative(this.root, real).split(path.sep).join("/");
    if (realRel && this.policy.isDenied(realRel)) throw new FsError("DENIED", "path is blocked by the filesystem security policy");
    return { rel, abs: real };
  }

  /** A listing entry, or null when the entry is denied, is a symlink-like entry (skipped, never traversed) or is neither file nor directory. */
  private entryFor(parentRel: string, name: string, parentAbs: string): Entry | null {
    const rel = parentRel ? `${parentRel}/${name}` : name;
    if (this.policy.isDenied(rel)) return null;
    const stat = lstatSync(path.join(parentAbs, name), { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink()) return null;
    if (stat.isDirectory()) return { path: rel, type: "dir" };
    if (stat.isFile()) return { path: rel, type: "file", size: stat.size };
    return null;
  }

  list(input = "", depth = 1): { path: string; entries: Entry[]; truncated: boolean } {
    const { rel, abs } = this.resolve(input);
    if (!statSync(abs).isDirectory()) throw new FsError("NOT_DIRECTORY", `not a directory: ${rel || "."}`);
    const entries: Entry[] = [];
    let truncated = false;
    const walk = (dirRel: string, dirAbs: string, level: number): void => {
      for (const name of readdirSync(dirAbs).sort()) {
        if (entries.length >= this.limits.maxDirEntries) {
          truncated = true;
          return;
        }
        const entry = this.entryFor(dirRel, name, dirAbs);
        if (!entry) continue;
        entries.push(entry);
        if (entry.type === "dir" && level < depth && !SKIP_DIRS.has(name)) walk(entry.path, path.join(dirAbs, name), level + 1);
      }
    };
    walk(rel, abs, 1);
    return { path: rel || ".", entries, truncated };
  }

  /** Files whose path matches `pattern`: a glob if it has glob characters, else a case-insensitive substring. */
  find(pattern: string, input = "", limit?: number): { path: string; pattern: string; matches: Entry[]; truncated: boolean; scanned: number } {
    if (!pattern.trim()) throw new FsError("INVALID_ARGUMENT", "pattern must not be empty");
    const { rel, abs } = this.resolve(input);
    if (!statSync(abs).isDirectory()) throw new FsError("NOT_DIRECTORY", `not a directory: ${rel || "."}`);
    const max = Math.min(limit ?? this.limits.maxSearchResults, this.limits.maxSearchResults);
    const re = /[*?]/.test(pattern) ? globToRegExp(pattern.includes("/") ? pattern : `**/${pattern}`) : null;
    const needle = pattern.toLowerCase();
    const matches: Entry[] = [];
    let scanned = 0;
    let truncated = false;
    const stack: [string, string][] = [[rel, abs]];
    while (stack.length > 0 && !truncated) {
      const [dirRel, dirAbs] = stack.pop() as [string, string];
      for (const name of readdirSync(dirAbs).sort()) {
        const entry = this.entryFor(dirRel, name, dirAbs);
        if (!entry) continue;
        if (++scanned > this.limits.maxScanEntries) {
          truncated = true;
          break;
        }
        if (entry.type === "dir") {
          if (!SKIP_DIRS.has(name)) stack.push([entry.path, path.join(dirAbs, name)]);
          continue;
        }
        if (re ? re.test(entry.path) : entry.path.toLowerCase().includes(needle)) {
          if (matches.length >= max) {
            truncated = true;
            break;
          }
          matches.push(entry);
        }
      }
    }
    matches.sort((a, b) => a.path.localeCompare(b.path));
    return { path: rel || ".", pattern, matches, truncated, scanned };
  }

  /** Reads a PNG/JPEG/WebP file as original bytes; extension AND magic bytes must agree. */
  readImage(input: string): { path: string; mimeType: ImageMime; bytes: number; width?: number; height?: number; data: Buffer } {
    const { rel, abs } = this.resolve(input);
    if (!rel) throw new FsError("NOT_FILE", "a file path is required");
    const stat = statSync(abs);
    if (!stat.isFile()) throw new FsError("NOT_FILE", `not a regular file: ${rel}`);
    const byExt = IMAGE_EXT[path.extname(rel).toLowerCase()];
    if (!byExt) throw new FsError("UNSUPPORTED_FORMAT", "only PNG, JPEG and WebP images are supported");
    if (stat.size > this.limits.maxImageBytes) throw new FsError("TOO_LARGE", `image is ${stat.size} bytes, above the ${this.limits.maxImageBytes}-byte limit`);
    const data = readFileSync(abs);
    const byMagic = sniffImage(data);
    if (byMagic !== byExt) throw new FsError("UNSUPPORTED_FORMAT", byMagic ? "file extension does not match the image content" : "file content is not a PNG, JPEG or WebP image");
    const dim = imageDimensions(data, byMagic);
    const { maxImageWidth, maxImageHeight, maxImagePixels } = this.limits;
    if (dim && (dim.width > maxImageWidth || dim.height > maxImageHeight || dim.width * dim.height > maxImagePixels)) {
      throw new FsError("DIMENSIONS_TOO_LARGE", `image is ${dim.width}x${dim.height}, above ${maxImageWidth}x${maxImageHeight} / ${maxImagePixels} pixels`);
    }
    return { path: rel, mimeType: byMagic, bytes: data.length, ...(dim ?? {}), data };
  }

  /** Reads a text file by 1-based inclusive line range, bounded by the configured limits. */
  read(input: string, startLine = 1, endLine?: number): { path: string; startLine: number; endLine: number; totalLines: number; truncated: boolean; nextStartLine: number | null; redactions: number; content: string } {
    const { rel, abs } = this.resolve(input);
    if (!rel) throw new FsError("NOT_FILE", "a file path is required");
    const stat = statSync(abs);
    if (!stat.isFile()) throw new FsError("NOT_FILE", `not a regular file: ${rel}`);
    if (stat.size > this.limits.maxFileBytes) throw new FsError("TOO_LARGE", `file is ${stat.size} bytes, above the ${this.limits.maxFileBytes}-byte limit`);
    if (!Number.isInteger(startLine) || startLine < 1) throw new FsError("INVALID_ARGUMENT", "startLine must be an integer >= 1");
    if (endLine !== undefined && (!Number.isInteger(endLine) || endLine < startLine)) throw new FsError("INVALID_ARGUMENT", "endLine must be an integer >= startLine");

    const buf = readFileSync(abs);
    if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) throw new FsError("BINARY", `binary file, content not returned: ${rel}`);
    const raw = buf.toString("utf8");
    // A file holding a private key is refused whole: never return the text around a key block.
    if (hasPrivateKey(raw)) throw new FsError("DENIED", "file contains private key material and is blocked by the filesystem security policy");
    const redacted = redactText(raw);
    const lines = redacted.text.split("\n");
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const totalLines = lines.length;
    const requestedEnd = endLine ?? startLine + this.limits.maxReadLines - 1;
    const cappedEnd = Math.min(requestedEnd, startLine + this.limits.maxReadLines - 1, totalLines);
    if (startLine > totalLines && totalLines > 0) throw new FsError("INVALID_ARGUMENT", `startLine ${startLine} is past the end of the file (${totalLines} lines)`);
    let content = lines.slice(startLine - 1, cappedEnd).map((line, i) => `${startLine + i}: ${line}`).join("\n");
    let charCut = false;
    if (content.length > this.limits.maxReadChars) {
      content = content.slice(0, this.limits.maxReadChars);
      charCut = true;
    }
    return {
      path: rel,
      startLine,
      endLine: totalLines === 0 ? 0 : cappedEnd,
      totalLines,
      truncated: charCut || cappedEnd < Math.min(requestedEnd, totalLines),
      nextStartLine: cappedEnd < totalLines ? cappedEnd + 1 : null,
      redactions: redacted.redactions,
      content,
    };
  }

  /**
   * Fixed-text (default) or regex content search over several patterns in ONE pass. Bounded by result, file and
   * byte budgets; the answer says when a budget cut the scan short. Matching runs on REDACTED text, so search is not
   * an oracle for a secret's value.
   */
  search(opts: SearchOptions): {
    path: string;
    mode: "text" | "regex";
    summary: { pattern: string; matches: number }[];
    matches: SearchMatch[];
    truncated: boolean;
    filesScanned: number;
    filesSkipped: { tooLarge: number; binary: number; secretContent: number };
    stoppedBy: "results" | "files" | "bytes" | null;
  } {
    const { maxPatterns, maxPatternLength, maxLineChars, maxMatchesPerFile, maxSearchFiles, maxSearchBytes } = this.limits;
    const patterns = [...new Set(opts.patterns)];
    if (patterns.length === 0 || patterns.some((p) => p === "")) throw new FsError("INVALID_ARGUMENT", "patterns must be non-empty strings");
    if (patterns.length > maxPatterns) throw new FsError("INVALID_ARGUMENT", `at most ${maxPatterns} patterns per call`);
    if (patterns.some((p) => p.length > maxPatternLength)) throw new FsError("INVALID_ARGUMENT", `a pattern is longer than ${maxPatternLength} characters`);
    const mode = opts.mode ?? "text";
    const flags = opts.caseSensitive ? "" : "i";
    const matchers = patterns.map((p) => {
      if (mode === "text") return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
      if (NESTED_QUANTIFIER.test(p)) throw new FsError("INVALID_ARGUMENT", `regex rejected as unsafe (nested quantifier): ${p}`);
      try {
        return new RegExp(p, flags);
      } catch {
        throw new FsError("INVALID_ARGUMENT", `invalid regular expression: ${p}`);
      }
    });
    const context = Math.min(Math.max(opts.contextLines ?? 0, 0), 3);
    const total = Math.min(opts.limit ?? this.limits.maxSearchResults, this.limits.maxSearchResults);
    // Fair share per pattern; when the limit is below the pattern count the first `total` patterns get one each, so the shares never sum past `total`.
    const share = Math.floor(total / patterns.length);
    const quota = patterns.map((_, p) => share || (p < total ? 1 : 0));
    const includes = (opts.include ?? []).map((g) => globToRegExp(g.includes("/") ? g : `**/${g}`));
    const excludes = (opts.exclude ?? []).map((g) => globToRegExp(g.includes("/") ? g : `**/${g}`));

    const { rel, abs } = this.resolve(opts.path ?? "");
    const rootStat = statSync(abs);
    const counts = patterns.map(() => 0);
    const matches: SearchMatch[] = [];
    const skipped = { tooLarge: 0, binary: 0, secretContent: 0 };
    let filesScanned = 0;
    let bytesScanned = 0;
    let stoppedBy: "results" | "files" | "bytes" | null = null;
    const clip = (l: string) => (l.length > maxLineChars ? l.slice(0, maxLineChars) + "…" : l);

    /** Scans one candidate. Returns the budget that forbids reading it, or null once it was handled. */
    const scanFile = (fileRel: string, fileAbs: string, size: number): "files" | "bytes" | null => {
      if (size > this.limits.maxFileBytes) {
        skipped.tooLarge++;
        return null;
      }
      if (filesScanned >= maxSearchFiles) return "files";
      if (bytesScanned + size > maxSearchBytes) return "bytes";
      filesScanned++;
      bytesScanned += size;
      const buf = readFileSync(fileAbs);
      if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
        skipped.binary++;
        return null;
      }
      const raw = buf.toString("utf8");
      if (hasPrivateKey(raw)) {
        skipped.secretContent++;
        return null;
      }
      const lines = redactText(raw).text.split("\n");
      let inFile = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = (lines[i] as string).slice(0, maxLineChars);
        for (let p = 0; p < matchers.length; p++) {
          if (!(matchers[p] as RegExp).test(line)) continue;
          counts[p] = (counts[p] as number) + 1;
          if ((counts[p] as number) > (quota[p] as number) || inFile >= maxMatchesPerFile) continue;
          inFile++;
          matches.push({
            pattern: patterns[p] as string,
            path: fileRel,
            line: i + 1,
            text: clip(line),
            ...(context > 0 ? { before: lines.slice(Math.max(0, i - context), i).map(clip), after: lines.slice(i + 1, i + 1 + context).map(clip) } : {}),
          });
        }
      }
      return null;
    };

    if (rootStat.isFile()) {
      stoppedBy = scanFile(rel, abs, rootStat.size);
    } else {
      const stack: [string, string][] = [[rel, abs]];
      walk: while (stack.length > 0) {
        const [dirRel, dirAbs] = stack.pop() as [string, string];
        for (const name of readdirSync(dirAbs).sort()) {
          const entry = this.entryFor(dirRel, name, dirAbs);
          if (!entry) continue;
          if (entry.type === "dir") {
            if (!SKIP_DIRS.has(name)) stack.push([entry.path, path.join(dirAbs, name)]);
            continue;
          }
          if (includes.length > 0 && !includes.some((re) => re.test(entry.path))) continue;
          if (excludes.some((re) => re.test(entry.path))) continue;
          stoppedBy = scanFile(entry.path, path.join(dirAbs, name), entry.size ?? 0);
          if (stoppedBy) break walk;
        }
      }
    }
    const capped = counts.some((c, p) => c > (quota[p] as number));
    return {
      path: rel || ".",
      mode,
      summary: patterns.map((pattern, i) => ({ pattern, matches: counts[i] as number })),
      matches,
      truncated: capped || stoppedBy !== null,
      filesScanned,
      filesSkipped: skipped,
      stoppedBy: stoppedBy ?? (capped ? "results" : null),
    };
  }
}
