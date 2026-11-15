// Every bound the read primitives enforce. Defaults are the proven Dev MCP values; the Server/Client configuration
// passes overrides, so operational policy stays configurable and the bounds themselves stay in code.
import { FsError } from "./errors.ts";

export type FsLimits = {
  maxFileBytes: number;
  maxImageBytes: number;
  maxReadLines: number;
  maxReadChars: number;
  maxSearchResults: number;
  maxDirEntries: number;
  /** Entries visited by one find call. */
  maxScanEntries: number;
  maxPatterns: number;
  maxPatternLength: number;
  maxSearchFiles: number;
  maxSearchBytes: number;
  /** Longer lines are matched on a prefix only: bounds regex cost and snippet size. */
  maxLineChars: number;
  maxMatchesPerFile: number;
  maxImageWidth: number;
  maxImageHeight: number;
  maxImagePixels: number;
  /** Largest file the controlled writer stores or edits. */
  maxWriteFileBytes: number;
  /** Most pages one PDF read returns. */
  maxPdfPages: number;
  /** Whole calendar days a trash folder is kept before the writer purges it. */
  trashRetentionDays: number;
};

export const DEFAULT_FS_LIMITS: FsLimits = {
  maxFileBytes: 1_000_000,
  maxImageBytes: 5_000_000,
  maxReadLines: 500,
  maxReadChars: 100_000,
  maxSearchResults: 100,
  maxDirEntries: 500,
  maxScanEntries: 50_000,
  maxPatterns: 10,
  maxPatternLength: 200,
  maxSearchFiles: 20_000,
  maxSearchBytes: 200_000_000,
  maxLineChars: 500,
  maxMatchesPerFile: 25,
  maxImageWidth: 8192,
  maxImageHeight: 16384,
  maxImagePixels: 64_000_000,
  maxWriteFileBytes: 20_000_000,
  maxPdfPages: 20,
  trashRetentionDays: 15,
};

export function resolveLimits(overrides: Partial<FsLimits> = {}): FsLimits {
  const limits = { ...DEFAULT_FS_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) throw new FsError("INVALID_ARGUMENT", `limit ${key} must be a positive integer`);
  }
  return limits;
}
