# Production deployment

This file defines only the production deployment contract. Architecture and security rationale live in [architecture.md](architecture.md).

## Topology

One REACH installation is one Compose project with exactly two services:

```text
ChatGPT
   |
OpenAI Secure MCP Tunnel
   |
reach-tunnel
   |
   v
reach-server:8787/mcp

Authorized Clients ----------> reach-server:8787/client
Installers ------------------> reach-server:8787/release/...
Operator --------------------> reach-server:8788/admin
```

- `reach-server` owns the application, Admin UI/API and both listeners.
- `reach-tunnel` owns only the OpenAI Secure MCP Tunnel.
- The tunnel routes only `/mcp`.
- Client runtime uses direct **WS** on the controlled/local network.
- **TLS/WSS is not required in V1.**
- 8788 defaults to host loopback because the MVP admin plane has no application login. Wider exposure requires an explicit network boundary plus direct-peer allowlist.

## Distribution

The production Server image carries the release manifest and canonical Linux/Windows Client artifacts. Installers may retrieve only catalog-gated release routes; there is no directory listing or arbitrary artifact path.

End users do not compile REACH.

## Persistent root

The operator supplies one durable host path mounted into the Server as `/reach-private`. It is the single top-level persistent/private mount for installation-specific runtime data.

If the path does not exist and can be created, create it. If it is unusable, fail clearly. Never silently use ephemeral storage.

An empty persistent root is a supported first-run condition and places REACH in setup mode until valid configuration exists.

## Client authorization

A new Client registers with its Client-owned Ed25519 public key and becomes **Pending**. It has no operational access until a human selects **Enable** in the Admin UI/API.

Disable closes the active session and refuses reconnect/use. Rotate Key remains Client-generated; only the replacement public key reaches the Server.

No trusted-network auto-admission, manual key copy, TLS/WSS requirement or third reverse-proxy/TLS container is part of V1.

## CI/CD

Canonical production flow:

```text
validation -> Build Release -> Deploy Production
```

Rollback remains explicit. The existing deployment controller remains the single deployment transaction owner.

## Acceptance

Production is accepted when:

- Server health and build identity match the release;
- MCP responds through the OpenAI tunnel;
- an authorized Enabled Client can connect over WS;
- Pending Clients cannot perform operational work;
- canonical Linux/Windows release artifacts are retrievable and hash-verifiable;
- admin routes are not exposed through the MCP tunnel;
- restart preserves persistent state and restores Server/tunnel operation.
