# ADR-0005 — One Server trust key: Server authentication, signed release metadata, freshness and rotation

**Status:** Accepted. Contract by Task #163; implemented by Task #164 of Story #153 (see "Implemented encoding and routes")

## Context

ADR-0004 gave every Client an Ed25519 identity that it proves to the Server. Trust runs one way only:

- the Client never authenticates the Server, so an on-path actor can answer as the Server and send a welcome, policy or update instruction;
- the release manifest is plain JSON served over HTTP and the updater checks only `size_bytes` and SHA-256 from that same manifest, so an on-path actor can replace manifest and artifact together and both checks still pass;
- nothing stops an old, valid manifest from being replayed to roll a Client back.

SHA-256 detects corruption only when the hash itself is trustworthy. The gap is authenticity of origin, not integrity of the artifact.

V1 stays on HTTP + WS in a controlled/local network (ADR-0004). TLS/WSS and mTLS are not introduced here.

## Decision

### 1. One Server trust key, one trust chain

The Server owns one persistent Ed25519 keypair, the **Server trust key**.

- The private key lives only in the Server's persistent private root (`/reach-private`) and never leaves the Server runtime, the repository, a log or a release artifact.
- The public key is **pinned** by every Client in its Bootstrap.
- The same key authenticates the Server on the WebSocket and signs the release metadata. There is no second signing key, no certificate hierarchy and no delegated release key in V1.
- Ed25519 stays the only primitive; no second cryptographic family is added.

Owners:

| Responsibility | Owner |
|---|---|
| Server trust private key, release epoch counter | Server, in `/reach-private` |
| Pinned Server public key, highest accepted release epoch, rotation generation | Client Bootstrap (the only owner of persistent Client configuration) |
| Exact manifest v2 bytes and artifacts | Release builder (release-manifest tooling); the Server only transports them |
| Signed envelope, `release_epoch` and signature | Server, with the trust key, when it serves a release |
| Client identity and admission | unchanged (ADR-0004) |

### 2. First trust is TOFU, explicitly and only once

The first install cannot authenticate the Server through the channel it is trying to authenticate. In V1 the installer fetches the Server public key from the Server it was pointed at and writes it into the Bootstrap as `server_trust_key`. This is **trust on first use** and depends on the V1 premise of a local/controlled network. It is not end-to-end authentication of the first HTTP fetch and the documentation never claims it is. An operator who needs more supplies the key out of band (`REACH_SERVER_TRUST_KEY` for the installer, which then takes precedence over the fetched key).

After the key is pinned, trust is strict: a Client never accepts a different Server key because of a hostname, an IP or a changed endpoint.

### 3. Server authentication on the WebSocket

The Client must authenticate the Server before it sends its own proof and before it accepts a welcome, policy, update or any command.

Contract for the handshake (wire shape is implemented in Task #164):

1. the Server opens the connection with its fresh `server_nonce` (the `challenge`, as before);
2. a current Client answers with `auth_begin`: ONLY a fresh `client_nonce`, no `client_id`, key, build or signature, nothing that identifies it;
3. the Server answers `server_auth`: a signature over the protocol label (`reach-v1/server-auth`), the outcome `auth`, `client_nonce`, `server_nonce`, the Server public key and the protocol context, so it cannot be replayed on another connection, purpose or protocol version. No session exists yet;
4. the Client verifies it with the pinned key (or follows a rotation chain from it) and closes the connection (fail closed, retried, never terminal) when it is missing or wrong, **before it sends anything that identifies it**;
5. only then the Client sends its `hello` with the existing Ed25519 proof, which now covers both nonces under its own label (`reach-v1/client-auth`), and repeats the same `client_nonce`;
6. the Server accepts that hello only on a socket that went through step 3 with the same nonce, verifies the Client and its Enabled state exactly as in ADR-0004, and the `welcome` or `reject` carries a second proof over the same nonces with its own outcome (`welcome` or `reject:<CODE>`).

An answer before step 3 is not authenticated, so a Client never treats it as terminal.

### 4. Signed release metadata

The release manifest stays the only discovery contract. Manifest v2 is produced and verified by the release builder and is **never modified** by the Server: the Server does not add, remove or reorder a field and does not re-serialize it. It is served inside a signed envelope `{ release_epoch, manifest, signature }`:

- `release_epoch`: the Server-owned freshness counter (section 5); it is outside the manifest;
- `manifest`: the exact manifest bytes as produced by the release builder, Base64url;
- `signature`: Ed25519 by the Server trust key over the label `reach-v1/release-manifest`, the canonical encoding of `release_epoch` and those exact manifest bytes. One deterministic, unambiguous representation of this input is mandatory (for example a fixed-width or length-prefixed `release_epoch` so the epoch and the manifest bytes cannot be confused); Task #164 chooses the concrete encoding and documents it. The signature is never computed over a re-serialized manifest.

The Client verifies the envelope signature with the pinned key and checks the epoch **before** it parses the manifest and **before** it trusts any `build_id`, `download_path`, `sha256` or `size_bytes`. SHA-256 and size of the artifact remain mandatory in addition to the signature: the signature authenticates the hashes, the hash authenticates the bytes. A manifest and artifact replaced together fail on the signature.

The public installers (`install.sh`, `install.ps1`) do **not** verify the envelope or any signature. They read the plain manifest (`/release/manifest`) and the published key (`/release/trust-key`) over the same unauthenticated http, check the artifact against the size and SHA-256 that plain manifest declares (which detects corruption only), and pin the key by trust on first use or by equality with a key supplied out of band. A first install, and a rerun without an installed Client, is therefore not cryptographically authenticated. Signed-envelope verification is mandatory in the **installed Client runtime**: central and subsequent updates are accepted only after the envelope verifies against the pinned key and the epoch rules hold (section 5), before the manifest is parsed.

### 5. Freshness: a monotonic release epoch

`release_epoch` is a positive integer owned by the Server and persisted in `/reach-private`. It is separate from `build_id`, which stays opaque and compared only by equality; no counter or ordering is derived from a build id.

- The Server increments the epoch whenever the effective release changes. An intentional rollback to an older artifact is published as new metadata with a **greater** epoch, so rollback remains possible.
- The Client persists the highest accepted epoch in its Bootstrap and refuses a lower one. The same epoch is accepted only when the SHA-256 digest of the exact manifest bytes equals the digest previously accepted at that epoch; a different digest at the same epoch is refused. An intentional rollback is the old artifact's unchanged manifest bytes inside a new envelope with a greater epoch.
- No timestamp or expiry is used as the anti-replay mechanism: it needs a trusted clock and breaks offline Clients.

### 6. Trust rotation and recovery

The Server trust key changes only through a **rotation statement** signed by the key currently pinned:

- content: label `reach-v1/trust-rotation`, the new public key and a monotonically increasing `rotation_generation`;
- a Client switches its pin only when the statement verifies with the currently pinned key and its generation is greater than the one it holds; there is no auto-accept of a new key by hostname or address;
- the Server keeps serving statements for the generations a Client may have missed, so an offline Client can step through them in order.

If the private trust key is lost or destroyed, no signed statement can exist. Recovery is a recorded operator action on each Client (re-bootstrap): the installer's explicit recovery (`--recover-trust`, Windows `REACH_RECOVER_TRUST=1`) with the new key supplied out of band; a normal install, rerun or update never replaces a pin. This is deliberate: a fleet must not be able to be taken over by whoever can answer from a given address. The operator keeps a protected backup of the key to avoid it.

### 7. Existing Clients without a pinned key

Clients installed before this decision have no `server_trust_key`. They receive the first build that supports pinning through the old, unauthenticated update path; that single step is unavoidable and is the same exposure as any first install. On the first connection the new build pins the key the Server presents together with a valid signed handshake, records that event in its log and in the Server audit trail, and from then on behaves strictly. A Client never runs unpinned after that first connection.

## Threat boundary

Addressed in V1:

- an on-path actor impersonating the Server to a pinned Client;
- substituting manifest and artifact together;
- replaying an older valid manifest (rollback);
- cross-connection and cross-protocol replay of a handshake signature;
- takeover of the pin through a rotation not authorized by the current key.

Explicitly **not** addressed:

- an attacker present and active during a first install or during the one-time pin of an existing Client (TOFU window);
- compromise of the Server host or of the Server private key (this is rotation/recovery territory, not prevention);
- confidentiality of traffic: HTTP/WS carry no encryption in V1;
- denial of service by an on-path actor.

## Implemented encoding and routes (Task #164)

One deterministic byte layout serves every signature (`layout` in `packages/shared/src/identity.ts`): the label, then each field, every one as a 4-byte big-endian length followed by its bytes. Counters are 8 bytes big-endian and keys are the raw 32 bytes; nonces, outcomes and the client_id are their UTF-8 text. Nothing is JSON.

| Signature | Label | Fields, in order | Signed by |
|---|---|---|---|
| Server authentication | `reach-v1/server-auth` | outcome (`welcome` or `reject:<CODE>`), client_nonce, server_nonce, Server public key, context `reach-ws-1` | Server trust key |
| Client authentication | `reach-v1/client-auth` | server_nonce, client_nonce, client_id | Client key |
| Release envelope | `reach-v1/release-manifest` | release_epoch (8 bytes), the exact manifest bytes | Server trust key |
| Trust rotation | `reach-v1/trust-rotation` | generation (8 bytes), previous raw key, new raw key | the key being replaced |

Handshake as built (three phases): `challenge`, then `auth_begin { client_nonce }`, then `server_auth { proof }`, then `hello` (with `client_nonce` and the signature over both nonces), then `welcome` or `reject`, each carrying `proof` = `{ server_public_key, server_signature, server_rotations? }`. The Server keeps the begun nonce per socket and refuses a hello that skips the phase, changes the nonce or falls back to the legacy form (`AUTH_FAILED`), a second `auth_begin` and any `auth_begin` when it has no trust key (`BAD_REQUEST`, no proof). A pre-change Client skips the first two phases and sends the legacy hello: it is accepted only as an incompatible, known and Enabled, management-only session, which is how it is updated, and it is given the old-format welcome without proof; a compatible build on the legacy path is refused (no downgrade).

Routes (service plane): `GET /release/manifest` still serves the exact manifest bytes (installers and pre-change Clients read it), `GET /release/envelope` serves `{ release_epoch, manifest, signature }` (manifest Base64url), `GET /release/trust-key` serves `{ public_key }`. The updater of a current Client reads only the envelope. The Server keeps its state in `server-trust.json` next to its config in the private root (key, epoch, last digest, rotation generation and the last 32 statements).

Installers: a pin is trust state and is never replaced from the unauthenticated http answer. Linux writes `REACH_SERVER_TRUST_KEY` into a fresh Bootstrap and adds it once to one that lacks it. An existing pin that equals the published key is left alone with its epoch, digest and generation; an existing pin that differs makes a normal install, rerun or update **fail before anything changes** and the message names the way out. That way out is the separate, explicit recovery: `--recover-trust` (Windows: `$env:REACH_RECOVER_TRUST='1'`) together with `REACH_SERVER_TRUST_KEY` set out of band to the new key, which must equal the published one; only then the pin is replaced and the epoch, digest and generation lines are removed in the same atomic write. Recovery is refused without that key, with a mismatching key and together with an update (`--staged`). Windows PowerShell 5.1 has no trustworthy Ed25519 verifier, so neither installer verifies a signature: first install is explicit trust on first use, and strict verification starts when the installed Client connects. With `REACH_SERVER_TRUST_KEY` supplied out of band the fetched key must match, which makes the pin the one the operator expects and so authenticates the Server identity at the first runtime connection; it does not retroactively authenticate the archive already downloaded over http, and the recovery switch does the same for the replacement pin.

## Scenarios Task #164 must prove

1. a valid signed handshake passes; a forged handshake or one signed with a wrong key fails closed;
2. a valid signed manifest passes; a tampered manifest fails; manifest and artifact replaced together fail;
3. a lower epoch fails; the same epoch with a different digest fails; a rollback published with a greater epoch passes;
4. a rotation signed by the pinned key passes; an unsigned or wrong-key rotation fails and the pin is unchanged;
5. a Client without a pin pins once on its first connection and is strict afterwards;
6. no private key (Server trust key, Client key) appears in the Bootstrap, a log, a manifest or an artifact.

## Planned fields (implemented in Task #164)

- Client Bootstrap: `server_trust_key` (public, Base64url), `release_epoch` (highest accepted), `rotation_generation`.
- Installer input: optional `REACH_SERVER_TRUST_KEY`.
- WebSocket handshake: `client_nonce`, `server_nonce`, `server_signature`, and the nonces folded into the Client proof.
- Release metadata: envelope `{ release_epoch, manifest, signature }` (the manifest bytes are the unmodified manifest v2; `release_epoch` is not a manifest field); Bootstrap lines `REACH_SERVER_TRUST_KEY`, `REACH_RELEASE_EPOCH`, `REACH_RELEASE_DIGEST`, `REACH_ROTATION_GENERATION`; rotation statements `{ new_public_key, rotation_generation, signature }`.
- Server persistent state under `/reach-private`: trust private key, current `release_epoch`, current `rotation_generation`.

## Out of scope

TLS/WSS, mTLS, a second signing key or certificate chain, build-id ordering, the post-handoff apply result of an update (Story #154) and any runtime change in this Task.
