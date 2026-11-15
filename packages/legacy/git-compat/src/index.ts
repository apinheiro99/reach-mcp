// The whole public surface of the temporary Git compatibility module, and its one disable switch: a caller that
// registers Git inspection does so only through createGitCompat, and `enabled: false` yields no inspector at all.
import { realpathSync } from "node:fs";
import { GitInspector, type GitInspectorOptions } from "./git-inspector.ts";

export { DEFAULT_GIT_LIMITS, GitInspector, type GitInspectorOptions, type GitLimits, type GitResult } from "./git-inspector.ts";

export type GitCompatConfig = GitInspectorOptions & { enabled: boolean };

/** Returns the read-only inspector, or null when the compatibility module is disabled. */
export function createGitCompat(config: GitCompatConfig): GitInspector | null {
  if (!config.enabled) return null;
  return new GitInspector({ ...config, root: realpathSync(config.root) });
}
