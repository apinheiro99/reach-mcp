# ADR-0004 — Client-owned Ed25519 identity with Pending/Enabled admission

**Status:** Accepted

## Context

REACH needs zero-touch Client installation without making the operator manually create credentials or bootstrap files. At the same time, a machine that can reach the Server must not automatically gain operational access.

## Decision

### Identity

Each Client generates one Ed25519 keypair locally.

- The private key belongs exclusively to the Client and never leaves the machine.
- The Server stores only the Client public key associated with the `client_id`.
- The Server never generates, receives, stores or recovers the Client private key.

### First admission

Installation is zero-touch up to registration:

1. the installer obtains and verifies the canonical Client artifact;
2. the Client generates its `client_id` and Ed25519 keypair locally;
3. the Client sends only its public key, non-secret metadata and proof of private-key possession;
4. the Server registers the Client as **Pending**;
5. Pending Clients have no operational access;
6. a human explicitly selects **Enable** in the Admin UI/API;
7. only an Enabled Client may establish operational access.

**Disable** closes the active session and refuses reconnect/use until re-enabled.

V1 explicitly rejects trusted-IP/CIDR auto-admission, one-time enrollment tokens, manual public-key copy/paste and Server-generated Client private keys.

### Transport

V1 targets a controlled/local network:

- HTTP for discovery, release and installers;
- WS for Client runtime;
- TLS/WSS is not required in V1;
- mTLS is out of scope.

### Key rotation

1. Admin UI/API requests rotation.
2. Server asks the authenticated Client to rotate.
3. Client generates a new Ed25519 keypair locally.
4. Client sends only the new public key.
5. Server atomically replaces the old public key.
6. Client reconnects and proves possession of the new private key.

## Ownership

- Client private key: **Client**
- Client public-key/admission state: **Server**
- Client authorization state: **Server**
- Logical projects/policies: **Server**
- Physical local root boundary: **Client**
- Admin UX: **Admin UI/API**

No second registry, shared-secret credential system or parallel policy owner is introduced.
