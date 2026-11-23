// The one owner of Ed25519 identity primitives, shared by Client (generate, sign) and Server (verify). Keys travel in the
// raw 32-byte form as unpadded base64url; the Client private key is a PKCS#8 DER blob in the same encoding and never
// leaves the Client. A signature binds the Server's fresh challenge to the signing client_id.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

/** A fresh unpredictable challenge for one connection. */
export const newNonce = (): string => randomBytes(32).toString("base64url");

const messageFor = (nonce: string, clientId: string): Buffer => Buffer.from(`reach-client-auth-v1\n${nonce}\n${clientId}`, "utf8");

/** The raw public key of a key pair, as base64url. */
const publicKeyOf = (key: KeyObject): string => Buffer.from(String(createPublicKey(key).export({ format: "jwk" }).x), "base64url").toString("base64url");

/** Generates a key pair; the private half is returned as a PKCS#8 base64url string for protected local state. */
export function generateIdentityKey(): { privateKey: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const enc = der.toString("base64url");
  return { privateKey: enc, publicKey: publicKeyOf(privateKey) };
}

/** Parses a stored private key; throws a fixed message that never contains the input. */
export function importPrivateKey(encoded: string): KeyObject {
  try {
    const der = Buffer.from(encoded, "base64url");
    if (der.length !== 48 || !der.subarray(0, 16).equals(PKCS8_ED25519_PREFIX) || der.toString("base64url") !== encoded) throw new Error("shape");
    return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch {
    throw new Error("invalid Ed25519 private key");
  }
}

export const publicKeyFromPrivate = (key: KeyObject): string => publicKeyOf(key);

/** Signs the challenge for this client_id; returns the base64url signature. */
export const signChallenge = (key: KeyObject, nonce: string, clientId: string): string => sign(null, messageFor(nonce, clientId), key).toString("base64url");

/** True only for a canonical public key whose signature over this challenge and client_id is valid. Never throws. */
export function verifyChallenge(publicKey: string, nonce: string, clientId: string, signature: string): boolean {
  try {
    const raw = Buffer.from(publicKey, "base64url");
    if (raw.length !== 32 || raw.toString("base64url") !== publicKey) return false;
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
    const sig = Buffer.from(signature, "base64url");
    return sig.length === 64 && sig.toString("base64url") === signature && verify(null, messageFor(nonce, clientId), key, sig);
  } catch {
    return false;
  }
}

/** The canonical, non-secret fingerprint of a public key: "ed25519:" and the SHA-256 of its raw 32 bytes in lowercase hex. */
export const publicKeyFingerprint = (publicKey: string): string => `ed25519:${createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex")}`;

/**
 * The Machine UUID: one stable, NON-secret identifier of an OS machine, derived from its native identifier (Linux /etc/machine-id,
 * Windows SMBIOS Win32_ComputerSystemProduct.UUID). The native id is canonicalized to 32 lowercase hex digits, hashed with SHA-256
 * and the first 128 bits are written in 8-4-4-4-12 form. It is a deliberately plain custom representation (no UUID version or
 * variant bits). It identifies the machine and never authenticates it: Ed25519 stays the only proof.
 */
export function machineUuid(nativeId: string): string {
  const canonical = nativeId.trim().replace(/^\{|\}$/g, "").replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(canonical)) throw new Error("native machine identifier is not 32 hexadecimal digits");
  const hex = createHash("sha256").update(`reach-machine-uuid-v1\n${canonical}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
