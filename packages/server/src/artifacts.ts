// The one owner of what a Client artifact download may return. The admin routes ask this source for a release manifest and
// for artifacts BY NAME; they never see a filesystem path. The directory source serves only a name in its catalog (the valid names present when it was built, ARTIFACT_NAME shaped)
// naming a regular file directly inside its directory, within explicit size limits, so a
// caller-supplied name can never become a path outside it.
// The manifest is opaque bytes owned by whoever produces the release; the Server only transports it.
import { createReadStream, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";

export const MANIFEST_FILE = "manifest.json";
export const MAX_MANIFEST_BYTES = 1_000_000;
export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
/** A servable name: starts with a letter or digit (no hidden files), no separator, no `..` segment, bounded length. */
/** At most this many names are cataloged; the rest of a larger directory is simply not declared. */
export const MAX_CATALOG_ENTRIES = 1000;
export const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type ArtifactSource = {
  /** The release manifest bytes, or null when there is none to serve. */
  manifest(): Buffer | null;
  /** A declared artifact by exact name: its byte size and a stream of exactly that many bytes, or null when it is not servable. */
  artifact(name: string): { size: number; stream(): Readable } | null;
};

export class DirectoryArtifactSource implements ArtifactSource {
  readonly #dir: string;
  readonly #catalog: ReadonlySet<string>;

  /** The catalog is the set of valid names present NOW: a file that appears later is not declared and is never served. */
  constructor(dir: string) {
    this.#dir = dir;
    this.#catalog = new Set(
      readdirSync(dir)
        .filter((name) => name !== MANIFEST_FILE && ARTIFACT_NAME.test(name))
        .sort()
        .slice(0, MAX_CATALOG_ENTRIES),
    );
  }

  /** A non-empty regular file directly in the directory (a symlink is not one) no larger than `limit`, or null. */
  #servable(name: string, limit: number): { file: string; size: number } | null {
    if (name !== MANIFEST_FILE && !this.#catalog.has(name)) return null; // allowlist first: no path is built for an undeclared name
    const file = path.join(this.#dir, name);
    const st = lstatSync(file, { throwIfNoEntry: false });
    return st?.isFile() && st.size > 0 && st.size <= limit ? { file, size: st.size } : null;
  }

  manifest(): Buffer | null {
    const found = this.#servable(MANIFEST_FILE, MAX_MANIFEST_BYTES);
    return found === null ? null : readFileSync(found.file);
  }

  artifact(name: string): { size: number; stream(): Readable } | null {
    if (name === MANIFEST_FILE) return null;
    const found = this.#servable(name, MAX_ARTIFACT_BYTES);
    return found === null ? null : { size: found.size, stream: () => createReadStream(found.file, { start: 0, end: found.size - 1 }) };
  }
}
