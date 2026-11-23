// The one rotating plain-text file primitive of the Server. The operational log and the audit trail each own one
// RotatingTextWriter and nothing else appends, rotates or deletes their files. Files are named by the local date they hold:
// `<base>-YYYY-MM-DD.log`, and when a line would pass the size limit the next same-day segment `<base>-YYYY-MM-DD.log.1`, `.2`, ...
// is written instead (nothing is renamed). A new date starts a new base file, so daily rotation needs no timer and no restart.
// Every segment of a date older than the retention is deleted together. Rotation and retention happen on write. Only exact
// `<base>-YYYY-MM-DD[.N].log` (and the legacy `<base>-YYYY-MM-DD-N.log`) regular files are ever removed, never anything else and
// never a symlink. The target file must itself be a regular file (a symlink or anything else is refused, never followed), and a
// single line larger than the size limit is refused rather than truncated: write() then returns false and nothing on disk changes.
import { closeSync, constants, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync, writeSync } from "node:fs";
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
  readonly #files: RegExp;
  #purgedOn = "";
  /** The date and the highest segment number currently being written; found on disk after a restart or a date change. */
  #current: { day: string; segment: number } | null = null;

  constructor(deps: RotatingTextDeps) {
    this.#deps = deps;
    this.#files = new RegExp(`^${deps.base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d{4}-\\d{2}-\\d{2})(?:-\\d+\\.log|\\.log(?:\\.(\\d+))?)$`);
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
      const target = this.#target(day(now), bytes, settings);
      if (target === null) return false;
      const fd = openSync(target, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        writeSync(fd, text);
      } finally {
        closeSync(fd);
      }
      if (this.#purgedOn !== day(now)) this.#purge(now, settings);
      return true;
    } catch {
      return false;
    }
  }

  #file(date: string, segment: number): string {
    return path.join(this.#deps.dir, `${this.#deps.base}-${date}.log${segment === 0 ? "" : `.${segment}`}`);
  }

  /** The file this line goes to: the day's highest segment, or the next one when the line would pass the limit; null when the path is not a regular file. */
  #target(date: string, incoming: number, settings: LogSettings): string | null {
    if (this.#current?.day !== date) this.#current = { day: date, segment: this.#highestSegment(date) };
    const file = this.#file(date, this.#current.segment);
    let size = 0;
    try {
      const info = lstatSync(file);
      if (!info.isFile()) return null;
      size = info.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
    if (size === 0 || size + incoming <= settings.max_bytes) return file;
    this.#current.segment += 1;
    return this.#file(date, this.#current.segment);
  }

  #highestSegment(date: string): number {
    let highest = 0;
    for (const name of readdirSync(this.#deps.dir)) {
      const match = this.#files.exec(name);
      if (match && match[1] === date && match[2] !== undefined) highest = Math.max(highest, Number(match[2]));
    }
    return highest;
  }

  /** Deletes every regular file of every date older than the retention, so no date is ever left partly deleted. */
  #purge(now: Date, settings: LogSettings): void {
    this.#purgedOn = day(now);
    const cutoff = day(new Date(now.getTime() - settings.retention_days * 86_400_000));
    for (const name of readdirSync(this.#deps.dir)) {
      const match = this.#files.exec(name);
      if (!match || (match[1] as string) >= cutoff) continue;
      const file = path.join(this.#deps.dir, name);
      if (lstatSync(file).isFile()) unlinkSync(file);
    }
  }
}
