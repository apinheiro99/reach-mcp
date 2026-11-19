# ADR-0003 — One production port, endpoint-separated routes

**Status:** Accepted (revised 2026-11-19; supersedes the three-port version of 2026-11-18)  
**Date:** 2026-11-18

## Context

REACH Clients dial the Server with authenticated outbound WSS, so a production Server cannot be reachable only from host loopback. The canonical release also carries the Client archives that other machines must be able to download without SSH, source checkout or manual relay.

The first version of this decision gave each responsibility its own TCP port (8787 service/client, 8788 admin, 8789 artifacts). That equated logical separation with listener separation and added flags, Compose mappings, healthchecks and tests for no product benefit. The Product Owner decided on KISS: one port, separated by endpoint. Nothing else about the approved architecture changes.

## Decision

The production Server has **one listener, port 8787**, with distinct endpoint families:

- `/mcp` — ChatGPT-facing MCP; the only route the OpenAI Secure MCP Tunnel carries;
- `/client` — authenticated Client WSS;
- `/health` — protected health;
- `/` and `/admin/...` — Web UI and administrative API, including first-boot setup mode;
- `/admin/api/release/manifest` and `/admin/api/release/artifacts/<name>` — read-only, catalog-gated release downloads, authenticated with the existing MCP bearer.

Every route family keeps the behavior and authentication it had when it had its own port. Setup mode, Web UI configuration, autosave, HITL and enrollment are unchanged. Nothing listens on 8788 or 8789.

## Deployment consequences

- The production Compose stack still has exactly two services, `reach-server` and `reach-tunnel`, and publishes one port, 8787 (`REACH_BIND`/`REACH_PORT`, loopback by default; the operator chooses the LAN address).
- The tunnel routes only `/mcp`; the admin and release routes are not tunnel routes.
- The healthcheck and the deploy controller probe the same listener.

## Security invariants

- the admin routes are never routed through the MCP tunnel;
- release routes are read-only and catalog-gated, no arbitrary file serving;
- Clients still require their own identity and credential for WSS;
- secrets are not baked into public images or public repositories.

## Consequences

- One listener, one port, one healthcheck.
- Owners are unchanged: `runtime.ts` composes, `auth.ts` authenticates, `artifacts.ts` owns the catalog, `admin.ts` owns the admin and release routes, `deploy/prod/deploy.mjs` owns the deploy transaction.
