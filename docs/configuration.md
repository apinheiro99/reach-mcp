# Configuration

This file is the operational configuration reference. Architecture and rationale live in [architecture.md](architecture.md).

## Server authority

The Server is the single operational authority for Clients, public keys, logical projects, roots, access modes, limits, routing and runtime state. Client private keys never leave the Client.

Mutable Server configuration is file-backed under the deployment-provided persistent root and activates atomically. Invalid changes never replace the last-known-good state.

## Network planes

- **8787 service plane:** MCP, Client WS, health, release download and Client registration.
- **8788 admin plane:** Web UI and administrative API.
- The OpenAI Secure MCP Tunnel routes only `/mcp` on 8787.
- Client↔Server runtime uses direct **WS** on the controlled/local network.
- **TLS/WSS is not required in V1.**
- Admin exposure defaults to host loopback. Any wider exposure requires an explicit deployment/network boundary and direct-peer allowlist.

## Client lifecycle

A Client is installed once per machine.

1. Installer downloads and verifies the canonical artifact.
2. Client generates its own `client_id` and Ed25519 keypair locally.
3. Client sends only the public key, non-secret metadata and proof of private-key possession.
4. Server registers the Client as **Pending**.
5. Pending Clients have no operational access.
6. A human explicitly selects **Enable** in the Admin UI/API.
7. Enabled Clients may connect and operate according to Server-owned project/root policy.
8. **Disable** closes the active session and refuses reconnect/use until re-enabled.

No trusted-IP/CIDR auto-admission, one-time enrollment token, manual public-key copy/paste or Server-generated Client private key is part of V1.

## Key rotation

The Admin UI/API requests rotation. The connected Client generates a new Ed25519 keypair locally and sends only the new public key. The Server atomically replaces the old public key; the Client reconnects and proves possession of the new private key.

## Client local state

Protected local Client state owns only machine-local material:

- Server endpoint;
- `client_id`;
- Ed25519 private key;
- physical root anchors.

The Server stores only the matching public key and Server-owned logical configuration.

## Persistence and logs

Runtime configuration, proposal state and logs live under the deployment-provided persistent root. Secrets never belong in the public repository, logs or CI output.

Project roots are explicit. There is no default root.
