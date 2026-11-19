# Configuration

How REACH is configured and operated. The reasons behind these rules are in [architecture.md](architecture.md); this page covers the practice. Development setup is in [development-environment.md](development-environment.md), installation in [install.md](install.md).

Real configuration, credentials and keys are never committed to the public repository. Production receives them through deployment-owned persistent paths; the backing storage location is an operator decision.

## Server

The Server is the configuration authority: projects, roots, access modes, allowlists, deny rules, limits and Clients are all defined there.

- **Web UI first.** The Web UI is the main way to configure the Server. No hand-written production `.env` is required.
- **File-backed.** The Web UI persists configuration to a simple, inspectable file under the deployment-provided persistent root (YAML or JSON; the exact format is an implementation detail). No database.
- **Autosave.** Changing an ordinary field, select or toggle saves automatically after a short debounce and validation. There is no generic Save button.
- **Safe activation.** Changes activate atomically; an invalid configuration never replaces the last-known-good one.
- **Action buttons** exist only for real actions: approve or reject an AI proposal, rotate or revoke a credential, and destructive operations.
- **Setup mode.** If configuration is missing or incomplete, the Server starts in setup mode: the data plane stays disabled until the initial configuration is completed in the Web UI. The Web UI and admin surface are served over HTTP, separate from the MCP tunnel.

## AI-assisted changes

The Server has separate service/client, administrative and artifact-distribution listeners. The administrative surface (`createAdminServer`) remains isolated from the data plane and artifact plane; where it binds and who may reach it is a deployment decision, with production private/local by default. `GET /admin` is one vanilla HTML page with no framework or bundler; configuration/status/proposal/credential operations stay Server-owned and the browser remains a thin consumer. Release transport is owned by the dedicated read-only artifact listener instead: it serves the authenticated canonical manifest and catalog-gated Client artifacts only, reuses the existing authentication and release-catalog owners, and exposes no admin mutation or MCP capability. `ServerConfigStore` stays the single configuration owner: it validates the candidate with the one schema, writes it atomically (temporary file, fsync, rename, mode 0600) and only then activates it, so an invalid or unwritable edit leaves the file and the active snapshot untouched. Policies are pushed to connected Clients once after each successful change. The page never receives credential digests; the MCP bearer is typed in plaintext only to replace it and is stored as a digest. Generating a Client credential is a discrete action: the plaintext is returned once and only its digest is stored. With no active configuration the admin surface still works (setup mode) while `/mcp` and `/client` stay refused.

Implemented proposal gate: `ProposalStore` keeps at most one pending proposal in one small JSON file (path injected by the runtime) holding `proposal_id`, `created_at`, the redacted editable configuration it was based on and the secret-free edit; it never holds the active configuration, a digest, a credential or the MCP bearer. ChatGPT has exactly two configuration tools, `reach_config_get` (read-only: the redacted editable configuration plus the pending proposal and its diff) and `reach_config_propose` (a complete replacement of the Clients and their projects; the input schema has no secret field and an invalid or second proposal is refused). Neither activates anything. The admin page shows the pending diff with Approve and Reject: `GET /admin/api/proposal`, `POST /admin/api/proposal/<id>/approve` and `POST /admin/api/proposal/<id>/reject`. Approval proves the current editable configuration still equals the proposal's base (otherwise `409 stale`, the proposal stays pending and nothing is merged), activates through `ServerConfigStore.applyEdit`, syncs policies to Clients once and removes the proposal; an activation failure leaves it pending and the old configuration active. Rejection only deletes the proposal.

Implemented logging and audit (`packages/server`): two separate plain-text outputs, each written through its own `RotatingTextWriter` (the one rotation and retention implementation) in a directory the runtime injects. The operational log (`reach.log`) has one line per event: `<ISO time> <LEVEL> <component> [request_id=<id>] <message>`, with levels DEBUG, INFO, WARNING, ERROR and CRITICAL; the Server logs Client connect, disconnect, stale and refusal (by code only), each sent request's completion, failure or timeout with its `request_id`, and proposal and admin outcomes. The audit trail (`audit.log`) has one tab-separated line per action, `<ISO time>` then `actor`, `action`, `client_id`, `project_id`, `target`, `request_id`, `result` where they apply: every mutating operation (`fs_write`, `fs_edit`, `fs_remove`) exactly once at its terminal result (`ok`, an error code or `timed_out`), human configuration edits, credential issue or replace (never the value), AI proposal creation and human approve, reject or stale. Control characters and ANSI escapes are removed from every value, and no credential, digest, request body or file content is written. Rotation happens on write, with no timer: the active file is renamed to `<name>-YYYY-MM-DD.log` (`-N` appended if taken) when the local date changes or the next line would pass the size limit, and rotated files of that name older than the retention are deleted (only exact regular files of that name). Settings are the `logging` object of the configuration, `max_bytes` (1 KiB to 1 GiB, default 10 MiB) and `retention_days` (1 to 365, default 5), edited in the admin page like any other field. A write failure is swallowed so logging never breaks the request it describes.

ChatGPT can inspect configuration and propose changes through typed MCP operations. Every AI/MCP-originated change is a proposal: it stays inactive, the Web UI shows the effective diff, and nothing activates until a human approves it. Autosave never bypasses this gate. Human edits in the Web UI keep using autosave.

## Clients

A Client is thin. Its local configuration is a private `KEY=VALUE` file with restrictive permissions where the platform supports it, holding:

- the Server endpoint;
- the `client_id`;
- the credential;
- the physical base roots this Client is ever allowed to expose (the local root anchors).

The Server defines projects and policy only inside those anchors, and the Client rejects anything that resolves outside them.

### Enrollment

1. Create the Client in the Web UI.
2. The Server generates the `client_id` and a credential. The credential is shown once, at enrollment or rotation, and cannot be recovered afterward.
3. Put the endpoint, `client_id`, credential and root anchors in the Client's local file.
4. Start the Client; it opens the outbound connection.

Rotation: generate a new credential, update the Client, verify it reconnects, then revoke the old one.

## Logs and persistence

Operational logs and the audit trail rotate at midnight or at a maximum size, with 5 days of retention by default; retention and size are configurable in the Web UI.

Log and private-configuration paths are deployment inputs, not public hardcoded product paths. Production deployment should persist the explicit Server config/proposal and log locations it supplies. An empty persistent root is a valid first-run condition and enters setup mode; an operator may also pre-seed that root from private backup/recovery material. The Client bootstrap is a separate protected operator file and is never part of the installed Client artifact.

## Rules

- No real secret, key or certificate is committed to the public repository, in examples, tests or documentation.
- Logs and CI output never print secret values or file contents.
- Project roots are explicit; there is no default root.
