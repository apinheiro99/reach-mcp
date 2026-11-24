// The one owner of the Server trust key (ADR-0005): one persistent Ed25519 key that authenticates the Server on the handshake and signs the
// release envelope, together with the release epoch and the rotation chain. It lives in ONE file next to the Server config in the private
// persistent root and is written atomically (mode 0600). The private key is never logged, returned or serialized anywhere else; a file that
// exists but cannot be read is an error, never a reason to generate a new key (that would silently orphan every pinned Client).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateIdentityKey, importPrivateKey, publicKeyFromPrivate, signReleaseEnvelope, signServerAuth, signTrustRotation, type TrustRotation } from "@reach-mcp/shared/identity";
import type { ServerProof } from "@reach-mcp/shared/wire";
import { sha256Hex } from "./auth.ts";

/** Most rotation statements retained; a Client further behind than this must be re-bootstrapped. Equals the wire schema bound. */
export const MAX_RETAINED_ROTATIONS = 32;

type TrustState = { signing_key: string; release_epoch: number; release_digest: string | null; rotation_generation: number; rotations: TrustRotation[] };

export type ReleaseEnvelope = { release_epoch: number; manifest: string; signature: string };

export class ServerTrustError extends Error {
  constructor() {
    super("invalid Server trust state");
  }
}

export class ServerTrustStore {
  readonly #file: string;
  #state: TrustState;

  /** Loads the state, or creates it once when the file does not exist. */
  constructor(file: string) {
    this.#file = file;
    this.#state = existsSync(file) ? ServerTrustStore.#read(file) : { signing_key: generateIdentityKey().privateKey, release_epoch: 0, release_digest: null, rotation_generation: 0, rotations: [] };
    if (!existsSync(file)) {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      this.#persist();
    }
  }

  static #read(file: string): TrustState {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as TrustState;
      importPrivateKey(parsed.signing_key);
      const counters = [parsed.release_epoch, parsed.rotation_generation];
      if (!counters.every((n) => Number.isSafeInteger(n) && n >= 0) || !Array.isArray(parsed.rotations) || (parsed.release_digest !== null && !/^[0-9a-f]{64}$/.test(parsed.release_digest))) throw new Error("shape");
      return parsed;
    } catch {
      throw new ServerTrustError();
    }
  }

  #persist(): void {
    const temporary = `${this.#file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.#state)}\n`, { mode: 0o600 });
    renameSync(temporary, this.#file);
  }

  #key = () => importPrivateKey(this.#state.signing_key);

  /** The public half, as pinned by Clients and fetched by the installer. */
  publicKey(): string {
    return publicKeyFromPrivate(this.#key());
  }

  /** The proof the handshake answer carries for a Client that sent its nonce; `outcome` is "welcome" or "reject:<CODE>". */
  proof(outcome: string, clientNonce: string, serverNonce: string): ServerProof {
    return { server_public_key: this.publicKey(), server_signature: signServerAuth(this.#key(), outcome, clientNonce, serverNonce), ...(this.#state.rotations.length > 0 ? { server_rotations: this.#state.rotations } : {}) };
  }

  /**
   * Signs the exact manifest bytes with the release epoch. The epoch advances only when the effective manifest bytes change (digest compare):
   * the same bytes always keep the same epoch, a restart never advances it, and serving older bytes again is new metadata with a greater epoch.
   */
  envelope(manifest: Buffer): ReleaseEnvelope {
    const digest = sha256Hex(manifest);
    if (digest !== this.#state.release_digest) {
      this.#state = { ...this.#state, release_epoch: this.#state.release_epoch + 1, release_digest: digest };
      this.#persist();
    }
    return { release_epoch: this.#state.release_epoch, manifest: manifest.toString("base64url"), signature: signReleaseEnvelope(this.#key(), this.#state.release_epoch, manifest) };
  }

  /** Replaces the trust key: the CURRENT key signs a statement for the new one with the next generation; the chain is retained for Clients that were offline. */
  rotate(): void {
    const next = generateIdentityKey();
    const generation = this.#state.rotation_generation + 1;
    const statement = signTrustRotation(this.#key(), generation, next.publicKey);
    this.#state = { ...this.#state, signing_key: next.privateKey, rotation_generation: generation, rotations: [...this.#state.rotations, statement].slice(-MAX_RETAINED_ROTATIONS) };
    this.#persist();
  }
}
