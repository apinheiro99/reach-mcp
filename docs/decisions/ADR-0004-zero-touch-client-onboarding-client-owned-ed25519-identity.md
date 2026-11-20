# ADR-0004 — Zero-touch Client onboarding with Client-owned Ed25519 identity

**Status:** Accepted

## Context

The first real canonical Client installation attempt exposed an architectural gap: release download had been automated, but enrollment, credential issuance, bootstrap preparation and activation still required manual operator steps through the private administrative plane. That made the Product Owner the integration point between otherwise separate components and violated the intended operator experience.

The required experience is intentionally simple: an authorized agent receives one instruction — access machine X and install the Client — and completes download, verification, identity creation, enrollment, protected local state, service installation and connection without asking for credentials or administrative data entry.

The architecture already separates the service plane (8787) from the administrative plane (8788) and uses a persistent outbound Client connection. The missing decision was ownership of Client identity and the first-enrollment flow.

## Decision

### Client identity

Each Client generates one Ed25519 keypair locally.

- The **private key belongs exclusively to the Client** and never leaves the machine.
- The **public key belongs to Server admission state**, associated with the `client_id`.
- The Server never generates, receives, stores or recovers the Client private key.
- The owner's private deployment/recovery repository may retain Server-side public-key/configuration state, but it is not the live runtime owner and does not store Client private keys.

This replaces the Server-generated shared Client credential model.

### Enrollment

First enrollment is automatic on the trusted service network.

1. An authorized agent on the target machine obtains and verifies the canonical platform release from the Server.
2. The Client creates its `client_id` and Ed25519 keypair locally.
3. The Client sends only its public key and non-secret enrollment metadata to the Server over the service plane.
4. The Server auto-admits the Client according to deployment-owned trusted-network/onboarding defaults.
5. The Server persists the Client identity/public key and effective logical policy.
6. The Client persists its private key, Server endpoint and local root anchors in protected local state.
7. The Client opens the persistent outbound WebSocket.
8. The Server sends a fresh random challenge; the Client signs it with Ed25519; the Server verifies with the stored public key.
9. Authentication is valid for that connection. Reconnect performs a fresh challenge. Ordinary messages are not individually signed.

No Web UI data entry, credential copy/paste, SSH tunnel to the admin plane or hand-written bootstrap is part of normal first enrollment.

### Installation defaults

Linux and Windows implement the same logical onboarding contract. Packaging/service mechanics are platform-specific, but identity, enrollment and operator experience are not duplicated.

The install agent may propose its current project directory as the initial root when unambiguous. If confirmation is necessary, root choice is the only normal onboarding question. Initial controlled write access is limited to `temp/**` with delete-as-trash unless deployment/private configuration explicitly changes it.

### Administrative plane

Port 8788 remains separate from 8787. Administrative exposure is controlled by deployment/private configuration as an allowed source IP or CIDR. There is no public-source hardcoded subnet. In the owner's environment the normal default is the same trusted network as the development/operator machine.

The Web UI is for post-install administration: enable/disable Clients, change project/root policy, inspect state and request key rotation. It is not required to bootstrap a Client.

### Key rotation

Key rotation is Client-generated:

1. UI/operator requests rotation.
2. Server asks the connected Client to rotate.
3. Client generates a new Ed25519 keypair locally.
4. Client sends only the new public key.
5. Server atomically replaces the stored public key.
6. Client reconnects and proves possession of the new private key.
7. Old key material is no longer accepted.

## Responsibility ownership

- Client private key generation/storage: **Client**
- Client public-key admission registry: **Server configuration owner**
- Connection authentication: **Server challenge + Client Ed25519 signature**
- Logical projects/policies: **Server**
- Physical local root boundary: **Client**
- Release distribution: **Server service plane**
- Environment-specific trusted networks/defaults: **deployment/private configuration**
- Admin UX: **Web UI on the administrative plane**

No second registry, shared-secret Client credential, per-platform identity implementation or parallel policy owner is introduced.

## Consequences

### Positive

- Zero-touch normal onboarding.
- Server never handles Client private secrets.
- No credential relay or manual bootstrap.
- Same identity model on Linux and Windows.
- Private admin plane remains independent from Client installation.
- Clear ownership prevents duplicated state and implementation drift.

### Trade-offs

- A machine reachable on the trusted enrollment network can auto-enroll; the deployment network boundary therefore matters.
- Ed25519 challenge/response and enrollment replay protection must be implemented and tested.
- Existing shared-credential code/configuration must be migrated or replaced.

## Rejected alternatives

- Server-generated Client bearer/shared credential: rejected because it requires secret generation/distribution and unnecessary shared-secret handling.
- Manual UI enrollment before install: rejected because it makes the operator the integration step.
- Temporary local admin CLI: rejected because it duplicates the administrative interface only to be discarded later.
- SSH tunnel to 8788 for onboarding: rejected because Client onboarding must not depend on reaching the admin plane.
- Hardcoded administrative subnet: rejected because network policy is environment-specific deployment/private configuration.
