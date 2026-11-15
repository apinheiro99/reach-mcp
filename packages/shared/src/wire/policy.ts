// The effective project policy the Server sends to a Client. It is Server-owned data, never local configuration:
// the Client only checks that its physical root stays inside the local root anchors, then enforces it.
import { z } from "zod";
import { ProjectId, WirePath } from "./ids.ts";

/** An explicit absolute host path in POSIX (/x), drive (C:\\x, C:/x) or UNC (\\\\host\\share) form; never cwd-relative.
 * Lexical only: the Client canonicalises it on its own host. */
export const AbsoluteHostPath = WirePath.regex(/^(\/|[A-Za-z]:[\\/]|\\\\)/, "must be an absolute host path");

const limit = z.int().min(1);
const globs = z.array(z.string().min(1).max(512)).max(200);

/** Overrides for the shared FsLimits bounds; any bound left out keeps the shared default. */
export const EffectiveLimits = z.strictObject({
  maxFileBytes: limit,
  maxImageBytes: limit,
  maxReadLines: limit,
  maxReadChars: limit,
  maxSearchResults: limit,
  maxDirEntries: limit,
  maxScanEntries: limit,
  maxPatterns: limit,
  maxPatternLength: limit,
  maxSearchFiles: limit,
  maxSearchBytes: limit,
  maxLineChars: limit,
  maxMatchesPerFile: limit,
  maxImageWidth: limit,
  maxImageHeight: limit,
  maxImagePixels: limit,
  maxWriteFileBytes: limit,
  maxPdfPages: limit,
  trashRetentionDays: limit,
}).partial();

export const EffectiveProjectPolicy = z.strictObject({
  project_id: ProjectId,
  physical_root: AbsoluteHostPath,
  mode: z.enum(["read_only", "read_write"]),
  writable_globs: globs.optional(),
  deny_globs: globs.optional(),
  limits: EffectiveLimits.optional(),
});
export type EffectiveProjectPolicy = z.infer<typeof EffectiveProjectPolicy>;
