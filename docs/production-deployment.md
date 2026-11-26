# Production deployment

This file defines only the production deployment contract. Architecture and security rationale live in [architecture.md](architecture.md).

## Topology

One REACH installation is one Compose project with exactly two services:

```text
ChatGPT
   |
OpenAI Secure MCP Tunnel
   |
reach-tunnel
   |
   v
reach-server:8787/mcp

Authorized Clients ----------> reach-server:8787/client
Installers ------------------> reach-server:8787/ , /install.sh , /install.ps1 , /release/...
Operator --------------------> reach-server:8788/admin
```

- `reach-server` owns the application, Admin UI/API and both listeners.
- `reach-tunnel` owns only the OpenAI Secure MCP Tunnel.
- The tunnel routes only `/mcp`.
- Client runtime uses direct **WS** on the controlled/local network.
- **TLS/WSS is not required in V1.**
- 8788 has no application login in the MVP, so the deployment must state its exposure explicitly: `REACH_ADMIN_BIND` (the host address Compose publishes it on) and `REACH_ADMIN_ALLOW_FROM` (the direct peers the Server admits, as addresses or CIDRs). Neither has a default; the Server refuses a non-loopback Admin listener without the allowlist. The controller takes both as `--admin-bind` and `--admin-allow-from` on `deploy` and `rollback` (an empty value is refused; `status` needs neither), and the pipeline passes them from the GitLab variables `REACH_ADMIN_BIND` and `REACH_ADMIN_ALLOW_FROM`. The values for a given environment are deployment data, not part of this repository.

## Distribution

The production Server image carries the release manifest and canonical Linux/Windows Client artifacts. Installers may retrieve only catalog-gated release routes; there is no directory listing or arbitrary artifact path.

End users do not compile REACH.

## Persistent root

The operator supplies one durable host path, `REACH_PRIVATE_PATH` (root `.env`, see `.env.example`; a GitLab variable in the pipeline), mounted into the Server as `/reach-private`. It is the single persistent/private mount for installation-specific runtime data: the Server keeps `config.json`, `proposal.json` and `logs/` there. The tunnel inputs (`REACH_TUNNEL_BINARY`, `REACH_TUNNEL_DIR`) stay separate and are never part of it.

The deployment controller (`deploy.ts`, `--private-path` on `deploy` and `rollback`) is the owner of the root: an existing directory is reused, a missing one is created owner-only, and anything else stops the command before Docker. The container writes as uid 1000, so the directory must be owned by that uid: a missing root is created directly when the deployer is uid 1000, or by root which then hands only that new directory to uid 1000; any other deployer must create it first. An existing directory with another owner is refused, never chowned or widened with chmod.

Upgrading an installation that still has the previous layout (a state file recording separate config and proposal paths, with logs in a `logs/` directory next to their parent): the first deploy copies the config, proposal and logs into the private root before Docker starts and leaves the old files untouched, so they can be removed later by hand. It refuses, before Docker, when the old paths are not that canonical layout, when an old file is missing, or when the private root already holds different Server data; it never starts an empty root over existing state and never overwrites a populated one. Deploy, update, automatic restore and rollback all use the same root, and the controller refuses to switch a running deployment to a different one. Never silently use ephemeral storage.

An empty persistent root is a supported first-run condition and places REACH in setup mode until valid configuration exists.

## Client authorization

A new Client registers with its Client-owned Ed25519 public key and becomes **Pending**. It has no operational access until a human selects **Enable** in the Admin UI/API.

Disable closes the active session and refuses reconnect/use. Rotate Key remains Client-generated; only the replacement public key reaches the Server.

No trusted-network auto-admission, manual key copy, TLS/WSS requirement or third reverse-proxy/TLS container is part of V1.

## CI/CD

Canonical production flow:

```text
validation -> Build Release -> Deploy Production
```

Rollback remains explicit. The existing deployment controller remains the single deployment transaction owner.

### GitHub publication

`Publish GitHub` runs on the `docker-prod` runner for successful default-branch push pipelines only, after `ci-tag-green` and `Build Release`, and before `Deploy Production`, which needs it. The script is `scripts/git-ci/publish-github.ts`. Publication uses operator-owned host material exactly like the RAG deployment pattern: the job sets its publication root from `REACH_PUBLICATION_PATH`, falling back to `$HOME/reach-prod/reach-private`, then reads `credentials/github/reach-mcp` and `config/github.env` (`REACH_GITHUB_OWNER`, `REACH_GITHUB_REPO`, optional `REACH_GITHUB_REPOSITORY`). The private/public key pair is generated once on the PROD host; the public key is registered on the GitHub `reach-mcp` repository as a Deploy Key with write access, while the private key remains only on the runner host with mode `0600`. Nothing from those files is tracked, logged or stored as a GitHub token. SSH uses `IdentitiesOnly` and host verification stays on. The tag is the green tag of the pipeline (`vYYYY.MM.NNNNNN`), fetched from GitLab and checked against the tested commit; `-fail` tags are never published. `CI_JOB_TOKEN` remains a GitLab-internal credential and is not used for GitHub publication.

## Data-plane promotion contract

A candidate's data plane is proven ready by one probe of the service plane, sent without any credential: `GET /health` on port 8787. The Server owns this behavior (`packages/server/src/http-server.ts`); it answers the challenge below only while a configuration is active. The probe needs no secret and never uses the Admin plane.

The smoke passes only when all of these hold:

| Property | Required value |
|---|---|
| Status | exactly `401` |
| `WWW-Authenticate` header | exactly `Bearer` |
| Body | empty |
| Redirects | not followed |

Everything else fails the smoke:

| Observed | Meaning |
|---|---|
| connection failure or no response | nothing is serving |
| `503` | no active configuration (setup mode) |
| `404` | wrong endpoint, or something else is listening |
| any `3xx` | a redirect is never readiness |
| any `2xx` | an unauthenticated request must not succeed |
| `401` without the exact `Bearer` challenge, or with a body | not the REACH authentication owner |
| any other status | not the contract |

No status range counts as success. The deployment controller (`deploy.ts`) enforces this contract in its `smoke-data-plane` check; a candidate that fails it is not promoted and the previous known-good deployment is restored.

## Acceptance

Production is accepted when:

- Server health and build identity match the release;
- MCP responds through the OpenAI tunnel;
- an authorized Enabled Client can connect over WS;
- Pending Clients cannot perform operational work;
- canonical Linux/Windows release artifacts are retrievable and hash-verifiable;
- admin routes are not exposed through the MCP tunnel;
- restart preserves persistent state and restores Server/tunnel operation.
