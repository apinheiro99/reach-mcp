# ADR-0003 — One production port, endpoint-separated routes

**Status:** Accepted (revised 2026-11-19; supersedes the three-port version of 2026-11-18)  
**Date:** 2026-11-18

## Context

REACH Clients dial the Server with authenticated outbound WSS, so a production Server cannot be reachable only from host loopback. The canonical release also carries the Client archives that other machines must be able to download without SSH, source checkout or manual relay.

The first version of this decision gave each responsibility its own TCP port (8787 service/client, 8788 admin, 8789 artifacts). The Product Owner then simplified to one port, but making that one listener reachable by Client machines would also expose the Web UI/admin API, which has no login of its own and is private by design. The Product Owner therefore decided on two ports: 8787 for everything Clients and ChatGPT need, 8788 only for the private Web UI/admin. There is no 8789; release downloads live on 8787. Nothing else about the approved architecture changes.

## Decision

The production Server has **two listeners**.

**8787 (service, reachable by Client machines)**:

- `/mcp` — ChatGPT-facing MCP; the only route the OpenAI Secure MCP Tunnel carries;
- `/client` — authenticated Client WSS;
- `/health` — protected health;
- `/release/manifest` and `/release/artifacts/<name>` — read-only, catalog-gated release downloads, with no credential: downloading and installing a Client needs network reachability only.

**8788 (private admin)**:

- `/` and `/admin/...` — Web UI and administrative API, including first-boot setup mode. No other route, and never routed through the MCP tunnel.

The two families never share a port: no admin route answers on 8787 and no service or release route answers on 8788.

Every route family keeps the behavior and authentication it had when it had its own port, except the release routes, which need no credential. Setup mode, Web UI configuration, autosave, HITL and enrollment are unchanged. Nothing listens on 8789.

## Deployment consequences

- The production Compose stack still has exactly two services, `reach-server` and `reach-tunnel`, and publishes two ports: 8787 (`REACH_BIND`/`REACH_PORT`, all host addresses by default so Client machines can reach it; the operator may narrow it to one address) and 8788 (`REACH_ADMIN_BIND`/`REACH_ADMIN_PORT`, host loopback by default; never a broad address).
- The tunnel routes only `/mcp`; the admin and release routes are not tunnel routes.
- The container healthcheck and the deploy controller read identity from the admin status route on 8788 and smoke the service listener on 8787.

## Security invariants

- the admin routes are never routed through the MCP tunnel and are never published on a broad address by default;
- release routes are read-only and catalog-gated, no arbitrary file serving;
- Clients still require their own identity and credential for WSS;
- secrets are not baked into public images or public repositories.

## Consequences

- Two listeners, two ports, one healthcheck; the exposure boundary is the port.
- Owners are unchanged: `runtime.ts` composes, `auth.ts` authenticates MCP and Clients, `artifacts.ts` owns the catalog, `admin.ts` owns the admin routes, `release.ts` owns the public release routes, `deploy/prod/deploy.mjs` owns the deploy transaction.
