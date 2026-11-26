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
9. **Retire** (irreversible, confirmed by the human) removes the Client record, with its key, status and projects, and closes any live session. Nothing is uninstalled on the Client machine; if it connects again it is an unknown Client and registers as **Pending**.

No trusted-IP/CIDR auto-admission, one-time enrollment token, manual public-key copy/paste or Server-generated Client private key is part of V1.

Ownership, one owner each. `ServerConfigStore` persists the identity and the authorization (public key, Pending/Enabled/Disabled, projects) and is the only writer. `ClientConnectionRegistry` owns the live sessions: it refuses a Pending or Disabled Client (`PENDING_APPROVAL`, `CLIENT_DISABLED`, both retried by the Client with its ordinary backoff, so an Enabled Client connects shortly after the human Enable with no manual step), and closes the session of a Client that is disabled. The Admin handler only calls them: `GET /admin/api/clients` (every Client with status, online/offline, `compatible`, `update_capable`, `update`, last seen and a public-key fingerprint, the `server_build`, plus counts that always add up as Online, Incompatible and Offline; never a key), and `POST /admin/api/clients/<client_id>/enable`, `/disable`, `/retire` (422 for an unknown id), `/rotate-key` and `/update` (the manual Client update; 202 accepted, 409 offline or busy, 422 not update-capable), and `PUT /admin/api/clients/<client_id>/display-name` with exactly `{ "display_name": string }` (1..100 characters after trimming, duplicates allowed). Each Client also carries one persisted boolean, `auto_update`, owned by the Server config and visible and editable through the Admin config (`GET`/`PUT /admin/api/config`). It defaults to `false` (OFF), including for a config written before the field existed and for a newly registered Pending Client: OFF means updates stay manual only. ON only permits the Server to trigger the same canonical update automatically (implemented by Story #155); there is no global toggle and the Client holds no policy. `client_id` is the immutable identity used for authentication, routing and every reference; `display_name` is mutable, operator-facing metadata only. A new Client suggests its hostname in the first hello, which the Server keeps only when it registers an unknown Pending Client; a known Client reconnecting never overwrites a name an operator set, and key rotation keeps it. The Clients screen is a view over that API and holds no policy.

## Key rotation

The Admin UI/API requests rotation (`POST /admin/api/clients/<client_id>/rotate-key`), only for an Enabled, connected Client; any other Client is refused with `409` and nothing is queued. The Server sends one `rotate_key` frame to that session. The connected Client generates a candidate Ed25519 keypair locally and answers with only the new public key; its valid key is untouched. The Server stages that public key next to the valid one (one atomic write) and then sends `rotate_committed`; the Client writes the candidate through its Bootstrap, and the Server closes the session. The Client reconnects with the new key; the first proof promotes it, and only then is the old key refused. Until that proof either key authenticates, so a failure at any single step leaves the Client and the Server with a common key. One rotation per Client at a time, bounded by the request timeout.

## Server trust key

Contract from [ADR-0005](decisions/ADR-0005-server-trust-identity-and-signed-release-metadata.md); the runtime follows in Task #164.

- The Server owns one persistent Ed25519 trust key under the deployment-provided persistent root (`/reach-private`), together with the current `release_epoch` and `rotation_generation`. The private key never leaves that root, and it is part of what the operator backs up: losing it forces a re-bootstrap of every Client.
- The same key authenticates the Server on the WebSocket and signs the release manifest envelope. There is no separate release signing key.
- `REACH_SERVER_TRUST_KEY` (public key, Base64url) is an optional installer input. When absent, the installer pins the key it fetches from the Server origin it was given on a first install (trust on first use, valid only on the V1 local/controlled network). When present the fetched key must match it. An existing pin is never replaced by a normal install, rerun or update.
- The state is one file, `server-trust.json`, next to the Server config in the private root, written atomically with mode 0600 and never regenerated when it exists (an unreadable file stops the Server instead of replacing the key). The release epoch advances only when the served manifest bytes change, never on a request or a restart.
- Routes: `/release/manifest` (exact bytes, unchanged), `/release/envelope` (`{ release_epoch, manifest, signature }`) and `/release/trust-key` (`{ public_key }`).
- Rotation is an operator action on the Server that publishes a statement signed by the currently pinned key; Clients follow it automatically in generation order. A lost private key has no statement: run the installer's explicit recovery on each Client (`--recover-trust` / `REACH_RECOVER_TRUST=1`, with `REACH_SERVER_TRUST_KEY` set to the new key out of band); a normal rerun never replaces a pin.
- A pinned Client refuses a handshake or manifest that does not verify with its pinned key, an envelope with a lower `release_epoch`, and the same epoch with a different manifest digest. `release_epoch` is part of the Server-signed envelope, never of the manifest, which stays as the release builder produced it. A rollback is published with a greater epoch.

## Client local state

Protected local Client state owns only machine-local material:

- Server endpoint;
- `client_id`;
- Ed25519 private key;
- physical root anchors;
- `REACH_SERVER_TRUST_KEY` (the pinned Server public key), `REACH_RELEASE_EPOCH` with `REACH_RELEASE_DIGEST` (the highest accepted release epoch and the digest of its manifest bytes) and `REACH_ROTATION_GENERATION`, all written through the Bootstrap's one atomic writer.

The Server stores only the matching public key and Server-owned logical configuration. A Client from before pinning has none of the three trust fields; it pins once on its first signed-handshake connection and is strict afterwards.

## Runtime configuration

Every mutable runtime value has ONE owner: the `runtime` section of the Server config (`ServerConfigStore`, `config.json` under `REACH_PRIVATE_PATH`). The names, canonical defaults, bounds and live-apply behavior are declared once in `packages/shared/src/runtime-settings.ts` (`RUNTIME_KNOBS`); no other file may carry a default, and `tests/runtime-guard.test.ts` fails CI when the default of a declared knob reappears as a raw number in production code. There is no second file, database, TOML or environment source for these values.

| Knob | Default | Range | Applies live | Owner / behavior |
|---|---|---|---|---|
| `heartbeat_interval_ms` | 30000 ms | 1000..300000 | yes | Client ping interval; pushed to connected Clients and re-armed |
| `stale_ms` | 90000 ms | 2000..900000 | yes | silence after which a session is stale (Server sweep and Client heartbeat) |
| `handshake_timeout_ms` | 10000 ms | 1000..120000 | yes | time a new socket has to complete the handshake; read per connection |
| `request_timeout_ms` | 30000 ms | 1000..600000 | yes | time a routed request or key rotation waits for the Client; read per request |
| `reconnect_initial_ms` | 1000 ms | 100..60000 | yes | first reconnect delay; read at every retry, pushed to connected Clients |
| `reconnect_max_ms` | 60000 ms | 1000..3600000 | yes | longest reconnect delay; read at every retry, pushed to connected Clients |
| `reconnect_jitter` | 0.2  | 0..1 | yes | fraction a reconnect delay may shrink or grow; read at every retry |
| `admin_autosave_debounce_ms` | 500 ms | 100..10000 | yes | Admin UI autosave delay; read by the UI from /admin/api/state |

- An absent override means the canonical default, never a component-local fallback. `PUT /admin/api/config` accepts an optional `runtime` section (validated as a whole: bounds, `stale_ms` above `heartbeat_interval_ms`, `reconnect_max_ms` not below `reconnect_initial_ms`); an autosave edit without it keeps the current one. AI proposals can never carry it. The full section is in `GET /admin/api/config` and the debounce is in `GET /admin/api/state`.
- Live application, no process restart: the Server registry reads `stale_ms`, `handshake_timeout_ms` and `request_timeout_ms` at the moment it needs them (one sweep timer, re-timed on every tick, never doubled). The five Client-side knobs travel with the `welcome` and with every `policy_sync` snapshot (an Admin change re-syncs every connected Client); the Client replaces its backoff and re-arms exactly one heartbeat timer. The Admin UI reads the autosave debounce from `/admin/api/state` before it draws a view.
- Before the first welcome a Client runs on the canonical defaults (its handshake timeout always does, since it is needed before the Server can answer).
- No knob is restart-only today; `restart_required` in the table is the place a structural value must be declared so it is never cached silently.
- Logging size and retention stay in the existing `logging` section of the same owner and already apply live through the writer's settings callback; an operational log level is not part of this change.

## Access Rules: precedence, sensitive defaults and approval

A project's Access Rules are its explicit rules: `deny_globs`, `allow_globs` and the write rules (`writable_globs`, `mode`). One evaluator (`buildPathPolicy` in `packages/shared/src/filesystem/path-policy.ts`) decides every path, in this order:

1. **immutable safety deny**: the internal `.git` store. No Access Rule opens it. Root confinement, traversal and symlink refusal are outside this ACL layer and never overridable either;
2. **explicit deny** (`deny_globs`);
3. **explicit allow** (`allow_globs`);
4. **inherited sensitive deny**: the built-in defaults (private keys, credentials, secrets, tokens, databases, `.env` family; `.env.example`-style templates are not denied);
5. **inherited allow**: everything else inside the root.

So `.env` is denied with no rule, and a human can open exactly `.env` with an explicit allow while `.env.production` stays denied; an explicit deny still beats an explicit allow. One effective explicit rule per glob: the same glob in `allow_globs` and `deny_globs` of one project is refused at validation, never resolved by list order. Writing additionally needs `mode`/`writable_globs`; an allow rule only lifts a read/write denial, it does not make a project writable. The Git compatibility listing stays conservative (it still excludes the inherited defaults).

**Who approves what.** Direct edits in the Admin UI go through `PUT /admin/api/config` and are already human-authorized. Everything proposed through MCP (`reach_config_propose`, proposal only, no MCP tool approves or rejects) is split into independent review items (one per Access Rule glob added or removed, per project added or removed, per changed field), each with a stable id (`i1`, `i2`, ...) and a status. `GET /admin/api/proposal` lists them; `POST /admin/api/proposal/<id>/items/<item>/approve|reject` decides one; `POST /admin/api/proposal/<id>/approve|reject` is only a convenience over the items still pending. Rejecting one item changes nothing and leaves the rest reviewable. An approval is applied to the CURRENT configuration (never to the old edit) through the one config owner, then Clients are synced once. It is stale-safe: if the configuration changed after the proposal (or after its last approved item), the remaining items answer 409 stale and nothing is applied; rejecting never needs a fresh base. The proposal closes when every item is decided. **Stored format and migration.** The pending proposal is one file. A file in the previous format (the whole proposed edit next to the base, no items) is migrated on first read: the same `proposal_id`, `created_at` and base are kept, the items are derived deterministically from the edit versus the base (all `pending`), and the itemized file is written atomically; nothing is approved or applied, no policy is synced, the active configuration is untouched, and a second read changes nothing. A file that cannot be read or migrated (malformed, an unknown or secret field, or an edit that changes nothing) is an explicit unusable state: `GET /admin/api/proposal` answers `unusable: true`, a new proposal is refused, the file is never rewritten or deleted, and a human resolves it. It is never treated as no proposal.

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

## Logging

The `logging` section of the Server config (the one owner; editable in the Admin API `PUT /admin/api/config`, any single field at a time) holds `level` (`DEBUG`, `INFO`, `RUNNING`, `WARNING`, `ERROR`, `CRITICAL`; default `RUNNING`), `max_bytes` (default 10 MiB) and `retention_days` (default 5). All three apply to the next line written, with no restart. A line below `level` is not written to the operational log; the audit trail ignores `level` and always records governance and security events.

Files are `reach-YYYY-MM-DD.log` and `audit-YYYY-MM-DD.log`. When a line would pass `max_bytes`, the same-day segment `...log.1`, then `.2`, is used (a restart continues in the highest segment). A line larger than `max_bytes` is refused whole. After `retention_days`, every segment of an expired date is deleted together, never only some.

Redaction: every operational and audit text is passed through one function immediately before it is written, at every level including DEBUG. Passwords, `Bearer`/`Basic` credentials, credentials inside URLs, API keys, any `name=value` or `name: value` whose name contains password, secret, token, api key, private key or credential (so `.env` style assignments too), known key shapes and private-key blocks become `[REDACTED]`; the surrounding text stays visible. Files are plain text, one line per event, with no control or ANSI characters.

## Admin UI

Ordinary edits autosave: the page waits `admin_autosave_debounce_ms` (from `/admin/api/state`, never a page constant) after the last change, then sends one edit; the header shows Editing, Saving, Autosaved or the Server's refusal as it is. There is no Save or Cancel for ordinary edits, and closing the Access drawer or leaving the page after Autosaved never reverts the Server state.

- **Projects**: the drawer lists the project's rules as Read / Write, Allow and Deny and writes `writable_globs`, `allow_globs` and `deny_globs` back losslessly; the browser never decides which rule wins (the Server does, see Access Rules). A root of `/` or a Windows drive root (`C:\`, `C:/`) asks for a confirmation before the request is sent; cancelling reloads the Server state and sends nothing. This is a warning only, and the Server still validates every root.
- **Proposals**: a proposal from MCP appears on the Projects screen with one row per item, each approved or rejected on its own; Approve all pending and Reject all pending act only on items still pending. A stored proposal that cannot be read is shown as unusable and blocks new proposals.
- **Clients**: each row shows the friendly name, the Machine UUID, the build the Client last connected with, one operational Status (Online, Offline, or Incompatible when the Server holds a live session it marked `compatible=false`, with both builds shown as the reason), how long an Online session has lasted (`connected_since`, set when the session was admitted, never the heartbeat) or, when Offline, the last seen (`last_seen`), and the update state, all from `/admin/api/clients`. The Client id is not shown on the row: it stays in the name field's tooltip and in the search, together with the Machine UUID and the fingerprint. Enabled/Disabled is the semantic toggle, not a status pill. **Update Client** is enabled only for an online, update-capable Client with no update in flight that the Server reports as not current (`update_available`; a Client already on the Server's build shows "Already up to date" and the endpoint refuses it with 409 `current`), and calls the Server's update endpoint, whose refusal is shown as is; Rotate Key needs a compatible online Client. The fleet counters (Total, Enabled, Pending, Disabled, Online, Incompatible, Offline) lay out in a shared grid that fits any number of cards. **Retire** removes the Client from the Server after a confirmation naming its Client id; uninstall is not part of this screen.
- **System**: Logging (level, maximum size, retention) and Runtime (every knob, with its bounds) are fields that autosave through `PUT /admin/api/config`; the Server validates and applies them live.
