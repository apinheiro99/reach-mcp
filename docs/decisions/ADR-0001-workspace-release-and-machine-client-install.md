# ADR-0001 — Workspace, release artifacts and machine-level Client installation

## Context

REACH started with a bootstrap-shaped root package and source-run Server/Client processes. Story #57 normalized package ownership, release transport, coordinated release output and the Client installation model before production deployment and SCOPE migration.

The design must keep one source of truth for shared security primitives, avoid Server/Client version drift, keep the MCP surface separate from administrative artifact delivery, and ensure a Client never widens the machine roots authorized by its operator.

## Decision

1. **One source repository, native npm workspaces.** The repository contains explicit Server, Client, shared and isolated legacy Git-compat packages under one root lockfile/install. Package-local behavior/tests remain package-owned; root orchestration/tests cover cross-cutting concerns only.

2. **Filesystem remove remains single-owned.** `FilesystemWriter` remains the only remove-to-trash owner. Each physical writable root owns its own managed `.lixeira`; cross-filesystem moves use rename first and an EXDEV-only safe copy-then-remove fallback.

3. **Admin is API-first.** Server-side config/proposal/auth owners remain authoritative. The browser is a thin consumer. Release manifest/Client artifact retrieval is an authenticated non-MCP admin API using the existing bearer owner and an explicit construction-time artifact catalog.

4. **One coordinated release identity.** One release build produces a Linux x64 Server runtime, Linux x64 Client `.tgz`, Windows x64 Client `.zip` and manifest v1 from one opaque build id/repository commit. Manifest v1 requires exactly those three role/platform artifacts, hashes final bytes and declares exact compatibility: `client_build == server_build`.

5. **Client installation is machine-level.** One Client is installed per machine, not per logical project. Defaults are `/opt/reach-mcp-client` on Linux and `C:\\Program Files\\REACH\\Client` on Windows, with explicit operator override. The bootstrap file remains separate and is the only local owner of endpoint, Client identity, credential and physical root anchors.

6. **Effective Project Configuration remains Server-owned.** One Client may hold multiple logical project policies simultaneously, but every `physical_root` must remain within the bootstrap anchors. An invalid policy snapshot is rejected atomically and does not replace the previous valid snapshot. No Client-local project ACL/delegation system is introduced.

7. **No silent update.** Install/update is always an explicit operator action. Server production image/Compose/CD is subsequent Story #10 work; SCOPE migration is subsequent Story #11 work.

## Consequences

- Source package ownership and release/runtime ownership are explicit.
- A target machine does not need a Git checkout or workspace links to run a release artifact.
- Server and Client cannot drift to independent release versions under manifest v1.
- Artifact download does not widen the MCP surface.
- A Client can serve multiple logical projects without multiplying processes/installations.
- Local root anchors remain the hard machine blast-radius boundary.
- Native Windows installer/Task Scheduler execution still requires proof on a Windows host; current validation is structural plus release-layout/module-resolution evidence.

## Alternatives considered

- Separate Server and Client repositories: rejected because it would duplicate shared security/wire ownership and invite drift.
- Monorepo framework beyond npm workspaces: rejected because native workspaces are sufficient.
- One Client per project: rejected because project identity/policy is already a Server-owned logical layer and local anchors are machine-level.
- Global machine trash: rejected because it crosses physical roots by design and complicates restore/ownership.
- Manifest-driven version ranges/secondary protocol version: rejected for MVP; exact opaque build equality is sufficient.
- Separate admin credential solely for artifact retrieval: rejected for now to avoid a second auth owner.
- Automatic Client self-update: rejected; explicit operator action is the product contract.

## Evidence

Story #57 Tasks #58–#61 provide the implementation and validation evidence: workspace/package normalization; EXDEV-safe per-root trash; authenticated catalog-gated artifact transport; coordinated release builder/manifest; Linux installer real-archive proof; Windows structural installer proof; and one-Client/multi-project anchor enforcement.

## Implementation notes

Public product documentation must not hardcode the Product Owner's private `/reach/reach-private` environment layout. The private environment currently groups live runtime configuration under `runtime/server` and `runtime/client`, with provisioning kept separate.