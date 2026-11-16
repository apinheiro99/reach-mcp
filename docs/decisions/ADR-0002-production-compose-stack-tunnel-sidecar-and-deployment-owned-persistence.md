# ADR-0002 — Production Compose stack, tunnel sidecar and deployment-owned persistence

**Status:** Accepted  
**Date:** 2026-11-16

## Context

REACH production now runs as a containerized Server exposed to ChatGPT through the OpenAI Secure MCP Tunnel. The deployment must remain reproducible for a public GitHub user while allowing an operator to choose where persistent private state lives.

The production rollout also proved three operational facts:

1. the Secure MCP Tunnel has an independent lifecycle from the Server and must not run inside the Server container;
2. the tunnel must start only after the Server data listener is reachable, but the Server must never depend on tunnel health;
3. configuration, proposal, credentials and logs are deployment-owned persistent inputs, not image contents or repository-specific paths.

## Decision

### One application stack, two services

A REACH production installation is one Docker Compose project named `reach` with two services:

- `reach-server` — owns REACH Server runtime, MCP/data plane and private admin listener;
- `reach-tunnel` — owns only the OpenAI Secure MCP Tunnel process.

The tunnel publishes no host port. It reaches only `http://reach-server:8787/mcp` through the internal Compose network. The admin listener is not a tunnel route.

Both services use restart semantics managed by Compose. The Server does not depend on the tunnel; the tunnel waits until the Server data listener answers before starting its client process.

### Deployment-owned persistent root

The public product does not know or require any private repository name or operator-specific storage topology.

The deployment supplies an operator-selected **persistent root**. The required runtime files/directories are derived from that root and mounted explicitly into the services.

If the persistent root is empty, REACH starts in setup mode and the operator completes configuration through the administrative UI. If it already contains valid state, REACH loads that state.

The persistent root may be local disk, a mounted filesystem, a Docker-host path or another operator-managed persistent storage location. Changing that backing storage must not require rebuilding the REACH images.

### Secrets and rotation

Secrets are never baked into images or committed to the public repository. Tunnel credentials are mounted read-only from the persistent runtime material.

Credential rotation is an operational action: replace the credential in the persistent source and restart/redeploy only the affected service. A Server image rebuild is not required.

### Deployment ownership

`deploy/prod/deploy.mjs` remains the single production transaction owner. CI/CD supplies the release and external inputs; it does not bypass the controller with ad-hoc Compose rollout logic.

Deploy is automatic after successful validation and release build. Rollback remains explicit/manual.

## Consequences

- Public installations have one reproducible deployment contract independent of the Product Owner's private repository.
- A private operator may seed an empty persistent root from backup/recovery material without changing the public product contract.
- The persistent root can be destroyed and recreated during testing; an empty-root test exercises the real first-run/setup path.
- Server and tunnel failures are isolated while remaining one operational stack.
- Additional MCP products can reuse the same pattern: one Compose project per MCP application, with separate server and tunnel responsibilities.

## Rejected alternatives

### Tunnel process inside the Server container

Rejected because it couples unrelated process lifecycles, complicates restart/failure handling and turns the application container into a process supervisor.

### Separate systemd tunnel lifecycle

Rejected for this Docker production model because it splits one application deployment across two lifecycle owners.

### Public dependency on a private repository

Rejected because a GitHub installation must be able to start from an empty persistent location and configure itself through the product UI.
