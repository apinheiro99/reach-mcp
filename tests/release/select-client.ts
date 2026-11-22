/** What a generic installer does: select by role/os/arch only (no filename constant, no platform parsing), exactly one entry. */
import { type Untrusted } from "../../scripts/release/manifest.ts";

export const selectClient = (manifest: Untrusted, os: string, arch: string): Untrusted => {
  const hits = manifest.artifacts.filter((a: Untrusted) => a.role === "client" && a.os === os && a.arch === arch);
  if (hits.length !== 1) throw new Error(`expected exactly one client for ${os}/${arch}, found ${hits.length}`);
  return hits[0];
};
