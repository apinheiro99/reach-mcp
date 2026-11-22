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
- The Server's own Admin default is host loopback. In the production container the Admin listener is non-loopback, so the deployment supplies `REACH_ADMIN_BIND` (host publication) and `REACH_ADMIN_ALLOW_FROM` (direct-peer allowlist) explicitly; there is no default for either.

Server flags that shape the admin plane: `--admin-host` (default loopback), `--admin-allow-from <addr-or-cidr,...>` (direct peers admitted; required whenever `--admin-host` is not loopback) `--admin-user <name>` (the operator label shown top right in the Admin UI; defaults to `admin`; one value, set by the deployment) and `--dev-live-reload` (DEV only, off by default).

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

Ownership, one owner each. `ServerConfigStore` persists the identity and the authorization (public key, Pending/Enabled/Disabled, projects) and is the only writer. `ClientConnectionRegistry` owns the live sessions: it refuses a Pending or Disabled Client (`PENDING_APPROVAL`, `CLIENT_DISABLED`, both retried by the Client with its ordinary backoff, so an Enabled Client connects shortly after the human Enable with no manual step), and closes the session of a Client that is disabled. The Admin handler only calls them: `GET /admin/api/clients` (every Client with status, online/offline, last seen and a public-key fingerprint, plus counts that always add up; never a key), and `POST /admin/api/clients/<client_id>/enable`, `/disable` and `/rotate-key`, and `PUT /admin/api/clients/<client_id>/display-name` with exactly `{ "display_name": string }` (1..100 characters after trimming, duplicates allowed). `client_id` is the immutable identity used for authentication, routing and every reference; `display_name` is mutable, operator-facing metadata only. A new Client suggests its hostname in the first hello, which the Server keeps only when it registers an unknown Pending Client; a known Client reconnecting never overwrites a name an operator set, and key rotation keeps it. The Clients screen is a view over that API and holds no policy.

## Key rotation

The Admin UI/API requests rotation (`POST /admin/api/clients/<client_id>/rotate-key`), only for an Enabled, connected Client; any other Client is refused with `409` and nothing is queued. The Server sends one `rotate_key` frame to that session. The connected Client generates a candidate Ed25519 keypair locally and answers with only the new public key; its valid key is untouched. The Server stages that public key next to the valid one (one atomic write) and then sends `rotate_committed`; the Client writes the candidate through its Bootstrap, and the Server closes the session. The Client reconnects with the new key; the first proof promotes it, and only then is the old key refused. Until that proof either key authenticates, so a failure at any single step leaves the Client and the Server with a common key. One rotation per Client at a time, bounded by the request timeout.

## Client local state

Protected local Client state owns only machine-local material:

- Server endpoint;
- `client_id`;
- Ed25519 private key;
- physical root anchors.

The Server stores only the matching public key and Server-owned logical configuration.

## Persistence and logs

Runtime configuration, proposal state and logs live under the deployment-provided persistent root (`REACH_PRIVATE_PATH`, mounted at `/reach-private` as `config.json`, `proposal.json` and `logs/`). Secrets never belong in the public repository, logs or CI output.

Project roots are explicit. There is no default root.

## Project filesystem access policy

Each logical project has one canonical access-policy object shared by Server configuration, wire sync, Client enforcement and Admin UI. The object describes one readable `physical_root`, an access mode, optional `writable_globs`, additive `deny_globs` and optional limits. There is no second UI-only permission model and nested permissions are not represented by duplicate projects.

The proven baseline is the Dev MCP contract: read access is rooted at the project root; controlled writes are an explicit allowlist of project-relative paths/globs; deny rules remain additive; bounded limits are part of the same policy; and delete moves allowed targets to `.lixeira` rather than unlinking them. REACH keeps those semantics while distributing policy from the Server to the Client.

Effective semantics are intentionally small:

- `read_only`: the project root is readable, subject to deny/content policy, and no filesystem mutation surface exists;
- `read_write` without `writable_globs`: the project root is writable, subject to deny/content policy and write limits;
- `read_write` with `writable_globs`: the project root remains readable, but filesystem mutation is allowed only for matching project-relative files/directories;
- `deny_globs` are additive restrictions and take precedence over writable allowlists;
- delete of an allowed target is trash semantics, not immediate unlink.

The Admin Projects view exposes this same object through the approved Project Access drawer (`docs/screens/REACH 08_MCP Project Access Dashboard.png`). The drawer opens over the Projects page and uses explicit Save changes/Cancel actions so an operator can review a complete policy change before it is applied (the scoped exception to autosave; inline fields on the table still autosave, and Save changes is then persisted by that same autosave). It has three tabs: Access & Permissions, Configuration (JSON) (the canonical object, read-only) and Details. Its visual hierarchy, layout and REACH dark/yellow design follow the approved reference rather than introducing a separate visual pattern.
