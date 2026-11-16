// Host-level blast-radius boundary: a Server effective policy is accepted only when its physical root, resolved to
// its real location, is an anchor or inside one. Containment is the shared path-aware helper, never a string prefix.
import { realpathSync, statSync } from "node:fs";
import { FsError, HOST_PLATFORM, isInsideRoot, type PathPlatform } from "@reach-mcp/shared/filesystem";
import { EffectiveProjectPolicy } from "@reach-mcp/shared/wire";

/** Returns the policy with `physical_root` replaced by its canonical path, or throws OUTSIDE_ROOT / NOT_DIRECTORY. */
export function acceptEffectivePolicy(anchors: readonly string[], policy: unknown, platform: PathPlatform = HOST_PLATFORM): EffectiveProjectPolicy {
  const parsed = EffectiveProjectPolicy.parse(policy);
  let real: string;
  try {
    real = realpathSync(parsed.physical_root);
    if (!statSync(real).isDirectory()) throw new FsError("NOT_DIRECTORY", "project root is not a directory");
  } catch (err) {
    if (err instanceof FsError) throw err;
    throw new FsError("NOT_FOUND", "project root does not exist");
  }
  if (!anchors.some((anchor) => isInsideRoot(anchor, real, platform))) throw new FsError("OUTSIDE_ROOT", "project root is outside the local root anchors");
  return { ...parsed, physical_root: real };
}
