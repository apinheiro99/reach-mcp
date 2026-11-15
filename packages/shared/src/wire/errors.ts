// One compact, serializable error shape for every refusal on the wire, plus the safe conversion into it. Raw
// messages and stacks of unknown exceptions are never serialized.
import { z } from "zod";
import { FsError, type FsErrorCode } from "../filesystem/errors.ts";

export const FS_ERROR_CODES = [
  "OUTSIDE_ROOT",
  "DENIED",
  "NOT_FOUND",
  "NOT_FILE",
  "NOT_DIRECTORY",
  "TOO_LARGE",
  "BINARY",
  "UNSUPPORTED_FORMAT",
  "DIMENSIONS_TOO_LARGE",
  "INVALID_ARGUMENT",
  "NOT_UNIQUE",
  "SYMLINK_REFUSED",
] as const satisfies readonly FsErrorCode[];
// Compile-time guard: adding an FsErrorCode without listing it here fails the typecheck.
type MissingFsCodes = Exclude<FsErrorCode, (typeof FS_ERROR_CODES)[number]>;
const allFsCodesListed: MissingFsCodes extends never ? true : never = true;
void allFsCodesListed;

export const TRANSPORT_ERROR_CODES = ["AUTH_FAILED", "DUPLICATE_CLIENT", "INCOMPATIBLE_BUILD", "BAD_REQUEST", "INTERNAL", "MUTATION_INDETERMINATE"] as const;

export const WireErrorCode = z.enum([...FS_ERROR_CODES, ...TRANSPORT_ERROR_CODES]);
export type WireErrorCode = z.infer<typeof WireErrorCode>;

export const WireError = z.strictObject({
  code: WireErrorCode,
  message: z.string().max(500),
  /** Optional, bounded, non-secret context (for example the two build identifiers of an incompatible build). */
  details: z.record(z.string().max(64), z.union([z.string().max(200), z.number(), z.boolean()])).refine((d) => Object.keys(d).length <= 10, { message: "at most 10 detail entries" }).optional(),
});
export type WireError = z.infer<typeof WireError>;

/** A refusal raised by the transport layers themselves (authentication, identity, build gate, malformed frames). */
export class WireFault extends Error {
  readonly code: (typeof TRANSPORT_ERROR_CODES)[number];
  readonly details?: WireError["details"];

  constructor(code: WireFault["code"], message: string, details?: WireError["details"]) {
    super(message);
    this.code = code;
    if (details) this.details = details;
  }
}

const MAX_MESSAGE = 500;
const clip = (text: string): string => (text.length > MAX_MESSAGE ? text.slice(0, MAX_MESSAGE) : text);

/** Maps any thrown value to the compact error. Only FsError and WireFault keep their own text; everything else is INTERNAL. */
export function toWireError(err: unknown): WireError {
  if (err instanceof FsError) return { code: err.code, message: clip(err.message) };
  if (err instanceof WireFault) return { code: err.code, message: clip(err.message), ...(err.details ? { details: err.details } : {}) };
  return { code: "INTERNAL", message: "internal error" };
}

/** The explicit build-gate refusal: just the two opaque identifiers, no negotiation data. */
export function incompatibleBuildError(clientBuild: string, serverBuild: string): WireError {
  return { code: "INCOMPATIBLE_BUILD", message: "client and server builds are not compatible", details: { client_build: clientBuild, server_build: serverBuild } };
}
