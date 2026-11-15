# Configuration

How REACH is configured and operated. The reasons behind these rules are in [architecture.md](architecture.md); this page covers the practice. Development setup is in [development-environment.md](development-environment.md), installation in [install.md](install.md).

Real configuration, credentials and keys are never committed to the public repository. They live in `reach-private`.

## Server

The Server is the configuration authority: projects, roots, access modes, allowlists, deny rules, limits and Clients are all defined there.

- **Web UI first.** The Web UI is the main way to configure the Server. No hand-written production `.env` is required.
- **File-backed.** The Web UI persists configuration to a simple, inspectable file in `reach-private` (YAML or JSON; the exact format is an implementation detail). No database.
- **Autosave.** Changing an ordinary field, select or toggle saves automatically after a short debounce and validation. There is no generic Save button.
- **Safe activation.** Changes activate atomically; an invalid configuration never replaces the last-known-good one.
- **Action buttons** exist only for real actions: approve or reject an AI proposal, rotate or revoke a credential, and destructive operations.
- **Setup mode.** If configuration is missing or incomplete, the Server starts in setup mode: the data plane stays disabled until the initial configuration is completed in the Web UI. The Web UI and admin surface are served over HTTP, separate from the MCP tunnel.

## AI-assisted changes

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

Operational logs and the audit trail rotate at midnight or at a maximum size, with 5 days of retention by default; retention and size are configurable in the Web UI. Logs live in `/reach/reach-mcp/logs`.

Persistence is recommended: mount persistent volumes over `/reach/reach-private` and `/reach/reach-mcp/logs`. Without them, recreating the environment loses configuration and logs.

## Rules

- No real secret, key or certificate is committed to the public repository, in examples, tests or documentation.
- Logs and CI output never print secret values or file contents.
- Project roots are explicit; there is no default root.
