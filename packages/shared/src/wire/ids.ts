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
/** The non-secret, application-neutral Machine UUID of an OS machine (8-4-4-4-12 lowercase hex). Correlation only, never authentication. */
export const MachineUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "must be a Machine UUID");
export const ProjectId = printable(128);
export const RequestId = printable(128);
/** The actual build identifier or tag of one side, compared for equality of compatibility by the Server, never parsed. */
export const BuildId = printable(128);
/** Ed25519 public key: the raw 32 bytes as unpadded base64url. Not secret; the Server stores it as the Client identity. */
export const PublicKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "must be a 32-byte base64url Ed25519 public key");
/** Ed25519 signature over a Server challenge: 64 bytes as unpadded base64url. */
export const Signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/, "must be a 64-byte base64url Ed25519 signature");
/** A fresh Server challenge: 32 random bytes as unpadded base64url, valid for one connection only. */
export const Nonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "must be a 32-byte base64url nonce");

/** A relative path as the caller wrote it; the shared filesystem policy decides whether it is acceptable. */
export const WirePath = z.string().max(WIRE_MAX_PATH);
