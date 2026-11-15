// The one rotating plain-text file primitive of the Server. The operational log and the audit trail each own one
// RotatingTextWriter and nothing else appends, rotates or deletes their files. The active file is `<base>.log`; when the
// local date changes or the next line would pass the size limit, it is renamed to `<base>-YYYY-MM-DD.log` (`-N` appended
// when that name is taken) and files older than the retention are deleted. Rotation happens on write, with no timer.
// Only exact `<base>-YYYY-MM-DD[-N].log` regular files are ever removed, never anything else and never a symlink. The active
// file must itself be a regular file (a symlink or anything else is refused, never followed), and a single line larger than
// the size limit is refused rather than truncated: write() then returns false and nothing on disk changes.
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

export type LogSettings = { max_bytes: number; retention_days: number };

export type RotatingTextDeps = { dir: string; base: string; settings: () => LogSettings; now?: () => Date };

/** One line of plain text: control characters (newlines, tabs, ANSI escapes) become single spaces, and length is bounded. */
export const oneLine = (value: string, max = 500): string =>
  // eslint-disable-next-line no-control-regex
  value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, " ").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, max);

const day = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export class RotatingTextWriter {
  readonly #deps: RotatingTextDeps;
  readonly #active: string;
  readonly #rotated: RegExp;
  #purgedOn = "";
  /** The local date of the last line written; after a restart it comes from the file itself. */
  #lastDay: string | null = null;

  constructor(deps: RotatingTextDeps) {
    this.#deps = deps;
    this.#active = path.join(deps.dir, `${deps.base}.log`);
    this.#rotated = new RegExp(`^${deps.base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d{4}-\\d{2}-\\d{2})(?:-(\\d+))?\\.log$`);
  }

  /** Appends one line. Logging must never break the work it describes, so a refusal or failure returns false instead of throwing. */
  write(line: string): boolean {
    try {
      const now = (this.#deps.now ?? (() => new Date()))();
      const settings = this.#deps.settings();
      const text = `${line}\n`;
      const bytes = Buffer.byteLength(text);
      if (bytes > settings.max_bytes) return false;
      mkdirSync(this.#deps.dir, { recursive: true });
      if (!this.#rotateIfNeeded(now, bytes, settings)) return false;
      const fd = openSync(this.#active, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        writeSync(fd, text);
      } finally {
        closeSync(fd);
      }
      this.#lastDay = day(now);
      if (this.#purgedOn !== day(now)) this.#purge(now, settings);
      return true;
    } catch {
      return false;
    }
  }

  /** False when the active path exists but is not a regular file; otherwise rotates if the day changed or the size limit would pass. */
  #rotateIfNeeded(now: Date, incoming: number, settings: LogSettings): boolean {
    if (!existsSync(this.#active) && !this.#isLink()) return true;
    const info = lstatSync(this.#active);
    if (!info.isFile()) return false;
    const startedOn = this.#lastDay ?? day(info.mtime);
    if (startedOn === day(now) && info.size + incoming <= settings.max_bytes) return true;
    let name = `${this.#deps.base}-${startedOn}.log`;
    for (let n = 1; existsSync(path.join(this.#deps.dir, name)); n++) name = `${this.#deps.base}-${startedOn}-${n}.log`;
    renameSync(this.#active, path.join(this.#deps.dir, name));
    this.#purge(now, settings);
    return true;
  }

  /** A dangling symlink makes existsSync false, so the active path is also checked with lstat. */
  #isLink(): boolean {
    try {
      return lstatSync(this.#active).isSymbolicLink();
    } catch {
      return false;
    }
  }

  #purge(now: Date, settings: LogSettings): void {
    this.#purgedOn = day(now);
    const cutoff = day(new Date(now.getTime() - settings.retention_days * 86_400_000));
    for (const name of readdirSync(this.#deps.dir)) {
      const match = this.#rotated.exec(name);
      if (!match || (match[1] as string) >= cutoff) continue;
      const file = path.join(this.#deps.dir, name);
      if (lstatSync(file).isFile()) unlinkSync(file);
    }
  }
}
