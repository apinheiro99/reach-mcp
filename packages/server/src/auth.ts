// The one owner of credential primitives on the Server: SHA-256 hashing, constant-time digest comparison and reading a
// single `Authorization: Bearer <token>` header. Client admission, the MCP endpoint and the artifact routes use these, nothing else does.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { ServerConfigStore } from "./config.ts";

/** Canonical lowercase hex SHA-256 of a credential. Not reversible; the plaintext is never kept. */
export const hashCredential = (credential: string): string => createHash("sha256").update(credential, "utf8").digest("hex");
/** The SHA-256 of raw bytes (a release manifest), as lowercase hex: the same single hashing owner, for data that is not a credential. */
export const sha256Hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Constant-time comparison of two SHA-256 hex digests. */
export const sameDigest = (a: string, b: string): boolean => a.length === 64 && b.length === 64 && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

/** The single bearer credential of an Authorization header, or null when absent, malformed or repeated. */
export function bearerCredential(headers: IncomingHttpHeaders): string | null {
  const value = headers.authorization;
  const match = typeof value === "string" ? /^Bearer (\S+)$/.exec(value) : null;
  return match?.[1] ?? null;
}

/** The one bearer check against the MCP bearer digest: 200 when allowed, 401 when refused, 503 when no configuration is active. */
export function authenticateBearer(config: ServerConfigStore, headers: IncomingHttpHeaders): 200 | 401 | 503 {
  const bearer = bearerCredential(headers);
  if (bearer === null) return 401;
  let expected: string;
  try {
    expected = config.mcpBearerDigest();
  } catch {
    return 503;
  }
  return sameDigest(hashCredential(bearer), expected) ? 200 : 401;
}
