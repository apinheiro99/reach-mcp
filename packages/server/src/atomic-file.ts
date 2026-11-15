// The one atomic file write of the Server: a private temporary file, fsync, then rename over the target, so a reader sees
// the old content or the new content and never a partial one. Callers decide what a failure means.
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

export function writeFileAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing was written */
    }
    throw error;
  }
}
