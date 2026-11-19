# ADR-0003 — LAN Client plane and dedicated artifact distribution plane

**Status:** Accepted  
**Date:** 2026-11-18

## Context

REACH Clients are machine-level agents that initiate an authenticated outbound WSS connection to the REACH Server. A production Server therefore cannot be reachable only from host loopback if Clients on other machines or containers in the operator network are expected to connect to it.

The canonical release also contains the Client installers/runtime archives. Those artifacts must be retrievable by machines that need to install or update a Client without exposing the administrative Web UI/API to the whole LAN.

The previous production deployment bound both Server listeners to host loopback and served release artifacts from the administrative listener. That is too restrictive for real multi-machine operation and couples artifact distribution to the admin exposure boundary.

## Decision

REACH production has three explicit network planes with one owner each:

### 1. Service / Client plane

The existing Server data listener owns:

- authenticated Client WSS connections;
- MCP data-plane requests;
- protected health.

In production it is **LAN-reachable by deployment policy** so authorized REACH Clients on other machines/containers can connect to the Server.

The OpenAI Secure MCP Tunnel routes only the MCP path on this listener. Making the listener LAN-reachable does not make the admin plane public.

Canonical production port: **8787**.

### 2. Administrative plane

The administrative Web UI/API remains a separate listener and a separate exposure boundary.

It owns:

- human configuration;
- Client registration and credential actions;
- proposal approval/rejection;
- operational administration.

It remains private/local by default and is **not** routed through the OpenAI Secure MCP Tunnel.

Canonical production port: **8788**.

### 3. Artifact distribution plane

Release manifest and Client runtime download move to a dedicated **read-only authenticated artifact listener**.

It serves only:

- the canonical release manifest;
- catalog-gated Client artifacts declared by that manifest.

It does not serve configuration mutation, Client credential issuance, proposal actions, general admin UI/API, MCP, filesystem operations or arbitrary files.

It is LAN-reachable by deployment policy so authorized machines can install/update the REACH Client without SSH or manual file copying.

Canonical production port: **8789**.

The artifact plane reuses the existing canonical release catalog/verification owner and an existing Server authentication owner; it must not create a second release catalog, second manifest model or unrelated secret-management subsystem.

## Deployment consequences

The production Compose stack still has exactly two services:

- `reach-server`;
- `reach-tunnel`.

This ADR adds no third container. The Server process owns the three listeners.

Default deployment bindings are configurable. The reference operator deployment binds:

- service/client plane (8787) to the operator LAN address/interface;
- admin plane (8788) to loopback/private management only;
- artifact plane (8789) to the operator LAN address/interface.

Firewall policy may narrow LAN sources, but firewall rules are deployment policy rather than product architecture.

## Client installation and update

A target machine:

1. reaches the artifact plane;
2. retrieves the manifest and platform artifact;
3. verifies the artifact against the manifest;
4. installs explicitly through the canonical platform installer;
5. connects to the service/client plane using its protected bootstrap.

No source checkout, SSH tunnel, manual PO file relay or direct container-network access is part of the normal installation contract.

## Security invariants

- admin is never exposed through the artifact plane;
- artifact routes are read-only and catalog-gated;
- artifact download requires authentication;
- Clients still require their own Client identity/credential for WSS;
- the MCP tunnel routes only MCP and never admin/artifact paths;
- secrets are not baked into public images or public repositories;
- no arbitrary file serving exists.

## Consequences

- Any authorized LAN machine/container can install and run a REACH Client without host SSH access.
- The administrative UI/API remains isolated.
- Server, Client and release artifacts remain one coordinated release identity.
- The same three-plane pattern can be reused by other MCP products that need remote Clients and distributable platform artifacts.
