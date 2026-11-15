// The one owner of credential primitives on the Server: SHA-256 hashing, constant-time digest comparison and reading a
// single `Authorization: Bearer <token>` header. Client admission and the MCP endpoint both use these, nothing else does.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

/** Canonical lowercase hex SHA-256 of a credential. Not reversible; the plaintext is never kept. */
export const hashCredential = (credential: string): string => createHash("sha256").update(credential, "utf8").digest("hex");

/** Constant-time comparison of two SHA-256 hex digests. */
export const sameDigest = (a: string, b: string): boolean => a.length === 64 && b.length === 64 && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

/** The single bearer credential of an Authorization header, or null when absent, malformed or repeated. */
export function bearerCredential(headers: IncomingHttpHeaders): string | null {
  const value = headers.authorization;
  const match = typeof value === "string" ? /^Bearer (\S+)$/.exec(value) : null;
  return match?.[1] ?? null;
}
