// A test Server's identity for the Client handshake tests: a fixed Server trust key and the signed proof a real Server attaches to its welcome and reject frames.
import { generateIdentityKey, importPrivateKey, signServerAuth, type TrustRotation } from "@reach-mcp/shared/identity";

export const SERVER_KEY = generateIdentityKey();

/** The `proof` object of a welcome or reject, signed over the Client's own nonce and the connection's challenge. */
export function serverProof(outcome: string, clientNonce: string, serverNonce: string, options: { key?: { privateKey: string; publicKey: string }; rotations?: TrustRotation[] } = {}) {
  const key = options.key ?? SERVER_KEY;
  return { server_public_key: key.publicKey, server_signature: signServerAuth(importPrivateKey(key.privateKey), outcome, clientNonce, serverNonce), ...(options.rotations ? { server_rotations: options.rotations } : {}) };
}

/** The `client_nonce` carried by the first frame (the hello) a test server received on one connection. */
export const clientNonceOf = (frames: unknown[]): string => String((frames[0] as { client_nonce?: string } | undefined)?.client_nonce);
