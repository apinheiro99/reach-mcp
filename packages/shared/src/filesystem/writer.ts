// Controlled writes: atomic write, exact-text edit and delete-as-trash, confined to ONE write root and governed by the
// same path and secret policy as the readers. Nothing is ever unlinked on request: "delete" moves the target into
// <root>/.lixeira/YYYY-MM-DD/. A full overwrite of an existing file is refused when normal read policy would refuse or
// redact its current content, so a caller cannot round-trip redacted text over the original. Targeted edit stays allowed.
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync, writeSync, type Stats } from "node:fs";
import path from "node:path";
import { FsError } from "./errors.ts";
import { type FsLimits, resolveLimits } from "./limits.ts";
import { buildPathPolicy, globToRegExp, HOST_PLATFORM, isInsideRoot, normalizeRelativePath, type PathPlatform, type PathPolicy } from "./path-policy.ts";
import { BINARY_SNIFF_BYTES } from "./reader.ts";
import { hasPrivateKey, redactText } from "./secret-policy.ts";

export const TRASH_DIR = ".lixeira";
/** Trash folders are named YYYY-MM-DD (the local calendar day); only folders of exactly this shape are ever purged. */
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;
/** Cross-filesystem copy reads and writes in bounded chunks: no whole-file buffer and no copy_file_range, which can stall on nested NFS mounts. */
const COPY_CHUNK_BYTES = 64 * 1024;

const pad = (n: number): string => String(n).padStart(2, "0");
const dayName = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** The local calendar day as a whole number, so ages are counted in days whatever the time of day. */
const dayNumber = (ms: number): number => {
  const d = new Date(ms);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / MS_PER_DAY;
};

/** One regular file, copied in bounded chunks; mode and times are restored afterwards, as a rename would have kept them. */
function copyFileChunked(from: string, to: string, st: Stats): void {
  const src = openSync(from, "r");
  try {
    const dst = openSync(to, "wx");
    try {
      const buf = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      for (let n = readSync(src, buf, 0, buf.length, null); n > 0; n = readSync(src, buf, 0, buf.length, null)) {
        for (let done = 0; done < n; ) done += writeSync(dst, buf, done, n - done);
      }
    } finally {
      closeSync(dst);
    }
  } finally {
    closeSync(src);
  }
  chmodSync(to, st.mode & 0o7777);
  utimesSync(to, st.atime, st.mtime);
}

/** Copies a file or directory tree (hidden entries included). A symlink is recreated as a link, never followed; any other entry type is refused. */
function copyTree(from: string, to: string): void {
  const st = lstatSync(from);
  if (st.isSymbolicLink()) {
    symlinkSync(readlinkSync(from), to);
  } else if (st.isDirectory()) {
    mkdirSync(to);
    for (const name of readdirSync(from)) copyTree(path.join(from, name), path.join(to, name));
    // Mode and times last: a read-only directory must stay writable while its children are created.
    chmodSync(to, st.mode & 0o7777);
    utimesSync(to, st.atime, st.mtime);
  } else if (st.isFile()) {
    copyFileChunked(from, to, st);
  } else {
    throw new FsError("NOT_FILE", `cannot move across filesystems: ${path.basename(from)} is neither a file, a directory nor a symlink`);
  }
}

/** Gives every directory under `from` owner write access, so its children can be unlinked. */
function unlockDirectories(from: string): void {
  const st = lstatSync(from);
  if (!st.isDirectory()) return;
  chmodSync(from, (st.mode & 0o7777) | 0o700);
  for (const name of readdirSync(from)) unlockDirectories(path.join(from, name));
}

/** Removes the source once its copy is complete. A rename never cares about a read-only directory inside the entry, so neither may this. */
function removeCopiedSource(from: string): void {
  try {
    rmSync(from, { recursive: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EACCES" && code !== "EPERM") throw err;
    unlockDirectories(from);
    rmSync(from, { recursive: true });
  }
}

/**
 * Moves an entry into the trash. rename first; only EXDEV (the trash is a different mount) falls back to copy-then-remove.
 * Every other rename error propagates. The source is removed only after the whole copy succeeded, so a failed copy leaves the
 * original intact and its partial copy is cleaned up.
 */
function moveIntoTrash(from: string, to: string): void {
  try {
    renameSync(from, to);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
  }
  try {
    copyTree(from, to);
  } catch (err) {
    try {
      rmSync(to, { recursive: true, force: true });
    } catch {
      /* the partial copy stays in the trash; the copy error below is the one that matters */
    }
    throw err;
  }
  removeCopiedSource(from);
}

export type FsWriterOptions = {
  /** Absolute, existing write root. Every mutation stays inside it. */
  root: string;
  /** Project root the deny rules are relative to; defaults to the write root. */
  projectRoot?: string;
  /** When set, only paths matching one of these globs (relative to the write root) are writable. */
  allowGlobs?: string[];
  limits?: Partial<FsLimits>;
  extraDenyGlobs?: string[];
  platform?: PathPlatform;
  /** Clock, injectable for trash dating. */
  now?: () => number;
};

export type WriteResult = { path: string; bytes: number };
export type RemoveResult = { path: string; movedTo: string };

export class FilesystemWriter {
  readonly root: string;
  private readonly rootRel: string;
  private readonly limits: FsLimits;
  private readonly policy: PathPolicy;
  private readonly platform: PathPlatform;
  private readonly allow: RegExp[] | undefined;
  private readonly now: () => number;

  constructor(options: FsWriterOptions) {
    this.platform = options.platform ?? HOST_PLATFORM;
    this.root = realpathSync(options.root);
    if (!statSync(this.root).isDirectory()) throw new FsError("INVALID_ARGUMENT", "write root is not a directory");
    const project = options.projectRoot ? realpathSync(options.projectRoot) : this.root;
    if (!isInsideRoot(project, this.root, this.platform)) throw new FsError("INVALID_ARGUMENT", "write root must be inside the project root");
    this.rootRel = path.relative(project, this.root).split(path.sep).join("/");
    this.limits = resolveLimits(options.limits);
    this.policy = buildPathPolicy(options.extraDenyGlobs);
    this.allow = options.allowGlobs?.map(globToRegExp);
    this.now = options.now ?? Date.now;
  }

  private isTrash(rel: string): boolean {
    const r = this.platform === "win32" ? rel.toLowerCase() : rel;
    return r === TRASH_DIR || r.startsWith(`${TRASH_DIR}/`);
  }

  /** Validates a mutation target: lexical rules, trash, allow list, deny policy, then no symlink on any existing component. */
  private target(input: string): { rel: string; abs: string } {
    // Any `..` segment is refused outright, even one that cancels out: it is never a legitimate write path.
    if (input.replaceAll("\\", "/").split("/").includes("..")) throw new FsError("OUTSIDE_ROOT", "path must not contain .. segments");
    const rel = normalizeRelativePath(input, this.platform);
    if (rel === "") throw new FsError("INVALID_ARGUMENT", "a file path is required");
    if (this.isTrash(rel)) throw new FsError("DENIED", `${TRASH_DIR} is managed by remove and cannot be written directly`);
    if (this.allow && !this.allow.some((re) => re.test(rel))) throw new FsError("DENIED", "path is not in the writable list");
    const projectRel = this.rootRel ? `${this.rootRel}/${rel}` : rel;
    const parts = projectRel.split("/");
    // Every prefix is tested: a rule naming a directory must deny its children too.
    if (parts.some((_, i) => this.policy.isDenied(parts.slice(0, i + 1).join("/")))) throw new FsError("DENIED", "path is blocked by the filesystem security policy");
    let current = this.root;
    for (const segment of rel.split("/")) {
      current = path.join(current, segment);
      const stat = lstatSync(current, { throwIfNoEntry: false });
      if (!stat) break;
      if (stat.isSymbolicLink()) throw new FsError("SYMLINK_REFUSED", "path is or passes through a symlink; writes through symlinks are not permitted");
    }
    return { rel, abs: path.join(this.root, rel) };
  }

  /** Content-level classification of an existing file with the read policy's own functions; nothing is returned. */
  private protectedReason(buf: Buffer): string | null {
    if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return "the existing file is binary";
    const raw = buf.toString("utf8");
    if (hasPrivateKey(raw)) return "the existing file holds key material";
    if (redactText(raw).redactions > 0) return "the existing file contains values that reads redact";
    return null;
  }

  private store(rel: string, abs: string, data: Buffer, guardOverwrite: boolean): WriteResult {
    if (data.length > this.limits.maxWriteFileBytes) throw new FsError("TOO_LARGE", `content is ${data.length} bytes; the per-file limit is ${this.limits.maxWriteFileBytes}`);
    const existing = lstatSync(abs, { throwIfNoEntry: false });
    if (existing?.isSymbolicLink()) throw new FsError("SYMLINK_REFUSED", "refusing to write through a symlink");
    if (existing && !existing.isFile()) throw new FsError("NOT_FILE", `not a regular file: ${rel}`);
    mkdirSync(path.dirname(abs), { recursive: true });
    // Re-check after creating parents: nothing created along the way may resolve outside the root.
    if (!isInsideRoot(this.root, realpathSync(path.dirname(abs)), this.platform)) throw new FsError("OUTSIDE_ROOT", "path resolves outside the write root");
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      writeFileSync(tmp, data, { flag: "wx" });
      // The overwrite guard runs here, immediately before the replacing rename, on the file as it is NOW.
      if (guardOverwrite && existing) {
        const current = statSync(abs).size <= this.limits.maxFileBytes ? readFileSync(abs) : null;
        const reason = current ? this.protectedReason(current) : "the existing file is larger than a normal read allows";
        if (reason) throw new FsError("DENIED", `full overwrite refused: ${reason}; use a targeted edit`);
      }
      renameSync(tmp, abs);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* nothing to clean */
      }
      throw err;
    }
    return { path: rel, bytes: data.length };
  }

  /** Removes trash folders whose STAMP date (not mtime) is older than the retention. Returns what was purged. */
  purgeTrash(): string[] {
    const trash = path.join(this.root, TRASH_DIR);
    let names: string[];
    try {
      names = readdirSync(trash);
    } catch {
      return [];
    }
    const purged: string[] = [];
    const today = dayNumber(this.now());
    for (const name of names) {
      const m = DAY.exec(name);
      if (!m) continue;
      const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const folderDay = Date.UTC(year, month - 1, day) / MS_PER_DAY;
      // An impossible date (month 13, 31 February...) is not a folder this module wrote: leave it alone.
      const d = new Date(folderDay * MS_PER_DAY);
      if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) continue;
      const dir = path.join(trash, name);
      // lstat, not stat: a symlink named like a date is never followed or purged.
      if (today - folderDay > this.limits.trashRetentionDays && lstatSync(dir).isDirectory()) {
        rmSync(dir, { recursive: true, force: true });
        purged.push(name);
      }
    }
    return purged;
  }

  /** Full-file write. Creating a file is always allowed; replacing one is refused when its content is protected. */
  write(input: string, content: string, encoding: "utf8" | "base64" = "utf8"): WriteResult {
    this.purgeTrash();
    const { rel, abs } = this.target(input);
    return this.store(rel, abs, Buffer.from(content, encoding), true);
  }

  /** Replaces `oldText` with `newText` in the raw file; `oldText` must occur exactly once unless replaceAll. Never returns file content. */
  edit(input: string, oldText: string, newText: string, replaceAll = false): WriteResult & { replacements: number } {
    if (oldText === "") throw new FsError("INVALID_ARGUMENT", "oldText must not be empty");
    this.purgeTrash();
    const { rel, abs } = this.target(input);
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st) throw new FsError("NOT_FOUND", `no such file: ${rel}`);
    if (!st.isFile()) throw new FsError("NOT_FILE", `not a regular file: ${rel}`);
    if (st.size > this.limits.maxWriteFileBytes) throw new FsError("TOO_LARGE", `file is ${st.size} bytes; the per-file limit is ${this.limits.maxWriteFileBytes}`);
    const buf = readFileSync(abs);
    if (buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)) throw new FsError("BINARY", "binary files cannot be edited as text");
    const parts = buf.toString("utf8").split(oldText);
    const count = parts.length - 1;
    if (count === 0) throw new FsError("NOT_FOUND", "oldText does not occur in the file");
    if (count > 1 && !replaceAll) throw new FsError("NOT_UNIQUE", `oldText occurs ${count} times; make it unique or set replaceAll`);
    return { ...this.store(rel, abs, Buffer.from(parts.join(newText), "utf8"), false), replacements: count };
  }

  /** "Delete" = move into <root>/.lixeira/YYYY-MM-DD/<path>. Nothing is ever unlinked. */
  remove(input: string): RemoveResult {
    this.purgeTrash();
    const { rel, abs } = this.target(input);
    const st = lstatSync(abs, { throwIfNoEntry: false });
    if (!st) throw new FsError("NOT_FOUND", `no such path: ${rel}`);
    let dest = path.join(this.root, TRASH_DIR, dayName(this.now()), rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    if (!isInsideRoot(this.root, realpathSync(path.dirname(dest)), this.platform)) throw new FsError("OUTSIDE_ROOT", "trash resolves outside the write root");
    // The same path deleted twice in one day must not overwrite the earlier copy: name-2.ext, name-3.ext, ...
    const ext = st.isFile() ? path.extname(dest) : "";
    const stem = dest.slice(0, dest.length - ext.length);
    for (let n = 2; lstatSync(dest, { throwIfNoEntry: false }); n++) dest = `${stem}-${n}${ext}`;
    moveIntoTrash(abs, dest);
    return { path: rel, movedTo: `${TRASH_DIR}/${path.relative(path.join(this.root, TRASH_DIR), dest).split(path.sep).join("/")}` };
  }
}
