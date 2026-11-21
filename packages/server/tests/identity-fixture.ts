// Test identities: real Ed25519 key pairs and the signed hello a Client would send for a given challenge.
import type { KeyObject } from "node:crypto";
import { generateIdentityKey, importPrivateKey, signChallenge } from "@reach-mcp/shared/identity";

export type TestIdentity = { privateKey: string; publicKey: string; key: KeyObject };

export function newIdentity(): TestIdentity {
  const { privateKey, publicKey } = generateIdentityKey();
  return { privateKey, publicKey, key: importPrivateKey(privateKey) };
}

/** The hello a Client answers a challenge with; fields may be overridden to build refusals. */
export const signedHello = (identity: TestIdentity, clientId: string, nonce: string, extra: Record<string, unknown> = {}) => ({
  kind: "hello",
  client_id: clientId,
  client_build: "ok-1",
  public_key: identity.publicKey,
  signature: signChallenge(identity.key, nonce, clientId),
  ...extra,
});

export const LAPTOP = newIdentity();
export const IDLE = newIdentity();
export const DESKTOP = newIdentity();
