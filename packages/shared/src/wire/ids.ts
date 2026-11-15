// Opaque, bounded scalars of the wire contract. They are deliberately NOT UUIDs or SemVer: the architecture asks
// only for non-empty, bounded, printable identifiers, and build strings stay opaque (no parsing, no ranges).
import { z } from "zod";

/** Generous transport ceilings, above any configured operational limit; the Client's own limits do the real bounding. */
export const WIRE_MAX_PATH = 4096;
export const WIRE_MAX_TEXT = 10_000_000;
export const WIRE_MAX_BASE64 = 28_000_000;

const hasControlCharacter = (value: string): boolean => [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const printable = (max: number) => z.string().min(1).max(max).refine((v) => !hasControlCharacter(v), { message: "must not contain control characters" });

export const ClientId = printable(128);
export const ProjectId = printable(128);
export const RequestId = printable(128);
/** The actual build identifier or tag of one side, compared for equality of compatibility by the Server, never parsed. */
export const BuildId = printable(128);
/** Secret-bearing: used only inside the client hello and never echoed by any error or helper. */
export const Credential = printable(1024);

/** A relative path as the caller wrote it; the shared filesystem policy decides whether it is acceptable. */
export const WirePath = z.string().max(WIRE_MAX_PATH);
