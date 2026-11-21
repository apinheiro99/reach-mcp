# ADR-0003 — Two production ports: reachable service plane and private admin plane

**Status:** Accepted  
**Date:** 2026-11-18  
**Revised:** 2026-11-20

## Context

Clients and installers must reach REACH without exposing the private Admin UI/API broadly. The earlier three-port design was simplified.

## Decision

The production Server has exactly two listeners.

### 8787 — service plane

- `/mcp` — ChatGPT-facing MCP; the only route carried by the OpenAI Secure MCP Tunnel;
- `/client` — authenticated Client **WS**;
- `/health` — protected health;
- `/release/...` — read-only, catalog-gated release/installer surface.

### 8788 — admin plane

- `/` and `/admin/...` — Web UI, administrative API and setup mode.

Admin routes never answer on 8787 and service/release routes never answer on 8788. Nothing listens on 8789.

V1 uses direct WS for Client runtime on the controlled/local network; TLS/WSS is not required.

## Deployment consequences

- Compose keeps exactly two services: `reach-server` and `reach-tunnel`.
- `reach-server` owns both listeners.
- `reach-tunnel` routes only `/mcp`.
- 8788 defaults to host loopback; wider exposure requires an explicit network boundary and direct-peer allowlist.
- Release routes are read-only and catalog-gated.

## Security invariants

- Admin routes never traverse the MCP tunnel.
- Clients use Client-owned Ed25519 identity.
- Unknown Clients are Pending until explicit human Enable.
- No trusted-network auto-admission.
- Secrets are never baked into public images or repositories.
