// The one owner of Ed25519 identity primitives, shared by Client (generate, sign) and Server (verify). Keys travel in the
// raw 32-byte form as unpadded base64url; the Client private key is a PKCS#8 DER blob in the same encoding and never
// leaves the Client. A signature binds the Server's fresh challenge to the signing client_id.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";

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
  return { privateKey: der.toString("base64url"), publicKey: publicKeyOf(privateKey) };
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
