/** What a generic installer does: select by role/os/arch only (no filename constant, no platform parsing), exactly one entry. */
export const selectClient = (manifest, os, arch) => {
  const hits = manifest.artifacts.filter((a) => a.role === "client" && a.os === os && a.arch === arch);
  if (hits.length !== 1) throw new Error(`expected exactly one client for ${os}/${arch}, found ${hits.length}`);
  return hits[0];
};
