# ADR-0005 — One Server trust key: Server authentication, signed release metadata, freshness and rotation

**Status:** Accepted (contract only; runtime is implemented by Task #164 of Story #153)

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
| Manifest content and artifacts | Release plane (release-manifest tooling and the Server artifact route) |
| Manifest signature and `release_epoch` assignment | Server, with the trust key, when it serves a release |
| Client identity and admission | unchanged (ADR-0004) |

### 2. First trust is TOFU, explicitly and only once

The first install cannot authenticate the Server through the channel it is trying to authenticate. In V1 the installer fetches the Server public key from the Server it was pointed at and writes it into the Bootstrap as `server_trust_key`. This is **trust on first use** and depends on the V1 premise of a local/controlled network. It is not end-to-end authentication of the first HTTP fetch and the documentation never claims it is. An operator who needs more supplies the key out of band (`REACH_SERVER_TRUST_KEY` for the installer, which then takes precedence over the fetched key).

After the key is pinned, trust is strict: a Client never accepts a different Server key because of a hostname, an IP or a changed endpoint.

### 3. Server authentication on the WebSocket

The Client must authenticate the Server before it sends its own proof and before it accepts a welcome, policy, update or any command.

Contract for the handshake (wire shape is implemented in Task #164):

1. the Client opens the connection with a fresh random `client_nonce`;
2. the Server answers with its fresh `server_nonce` and a `server_signature`;
3. the signature covers a protocol label (`reach-v1/server-auth`), `client_nonce`, `server_nonce`, the Server public key and the connection's protocol version, so it cannot be replayed on another connection, protocol or purpose;
4. the Client verifies it with the pinned key and closes the connection (fail closed, no retry with another key) when it is missing or wrong;
5. only then the Client signs its existing Ed25519 proof, which now also covers both nonces under its own label (`reach-v1/client-auth`);
6. the Server verifies the Client and its Enabled state exactly as in ADR-0004.

### 4. Signed release metadata

The release manifest stays the only discovery contract (schema v2 content and fields are unchanged). It is served inside a signed envelope:

- `manifest`: the exact manifest bytes, Base64url (the signature is over these bytes, never over a re-serialization);
- `signature`: Ed25519 over the label `reach-v1/release-manifest` followed by those bytes;
- the signed manifest content carries `release_epoch` (below).

The Client verifies the signature with the pinned key **before** it trusts any `build_id`, `download_path`, `sha256` or `size_bytes`. SHA-256 and size of the artifact remain mandatory in addition to the signature: the signature authenticates the hashes, the hash authenticates the bytes. A manifest and artifact replaced together fail on the signature.

The installer scripts verify the envelope against the key they just pinned. That check proves consistency, not first-use authenticity (section 2).

### 5. Freshness: a monotonic release epoch

`release_epoch` is a positive integer owned by the Server and persisted in `/reach-private`. It is separate from `build_id`, which stays opaque and compared only by equality; no counter or ordering is derived from a build id.

- The Server increments the epoch whenever the effective release changes. An intentional rollback to an older artifact is published as new metadata with a **greater** epoch, so rollback remains possible.
- The Client persists the highest accepted epoch in its Bootstrap and refuses a lower one. The same epoch is accepted only for the same authenticated manifest digest; a different digest at the same epoch is refused.
- No timestamp or expiry is used as the anti-replay mechanism: it needs a trusted clock and breaks offline Clients.

### 6. Trust rotation and recovery

The Server trust key changes only through a **rotation statement** signed by the key currently pinned:

- content: label `reach-v1/trust-rotation`, the new public key and a monotonically increasing `rotation_generation`;
- a Client switches its pin only when the statement verifies with the currently pinned key and its generation is greater than the one it holds; there is no auto-accept of a new key by hostname or address;
- the Server keeps serving statements for the generations a Client may have missed, so an offline Client can step through them in order.

If the private trust key is lost or destroyed, no signed statement can exist. Recovery is a recorded operator action: install the new key through the installer path of section 2 on each Client (re-bootstrap). This is deliberate: a fleet must not be able to be taken over by whoever can answer from a given address. The operator keeps a protected backup of the key to avoid it.

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
- Release metadata: envelope `{ manifest, signature }`; `release_epoch` inside the manifest; rotation statements `{ new_public_key, rotation_generation, signature }`.
- Server persistent state under `/reach-private`: trust private key, current `release_epoch`, current `rotation_generation`.

## Out of scope

TLS/WSS, mTLS, a second signing key or certificate chain, build-id ordering, the post-handoff apply result of an update (Story #154) and any runtime change in this Task.
