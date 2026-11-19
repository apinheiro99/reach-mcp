# Production deployment

This page defines the public production deployment contract. It intentionally contains no operator-specific host, private-repository or secret values.

## Topology

One REACH installation is one Compose project, `reach`, with two services:

```text
ChatGPT
   |
OpenAI Secure MCP Tunnel
   |
reach-tunnel
   |
   | internal Compose network, MCP path only
   v
reach-server:8787/mcp

Authorized LAN Clients ---------> reach-server:8787/client
Authorized LAN installers ------> reach-server:8787/admin/api/release/...
Operator -----------------------> reach-server:8787/admin
```

The Server owns one network listener, **8787**, with distinct endpoint families: `/mcp`, `/client`, `/health`, `/admin/...` (Web UI, administrative API, setup mode) and the read-only release routes under `/admin/api/release/...`. Nothing listens on 8788 or 8789.

`reach-server` owns the application and its one listener. `reach-tunnel` owns only the Secure MCP Tunnel client. The tunnel publishes no host port and routes only `/mcp`. The Server does not depend on tunnel health; the tunnel waits until the Server service listener responds before it starts. Both services restart automatically through Compose.

Bindings are configurable. A deployment may use an explicit LAN address, a trusted interface or a broader bind narrowed by host/network firewall policy. The product contract is reachability and separation of planes, not a hardcoded subnet or interface.

## Client distribution

The production Server image carries the exact release `artifacts/` tree that belongs to the deployed Server build, including:

- `manifest.json`;
- `reach-client-linux-x64.tgz`;
- `reach-client-win32-x64.zip`.

Authorized target machines retrieve the manifest and platform Client archive from the release routes of the Server, verify the archive against the manifest, install it explicitly with the platform installer, then connect to `/client` with their protected Client bootstrap.

SSH tunneling, manual file relay and source checkout are not part of the normal Client installation contract.

## Persistent root

The operator supplies one persistent root for the installation. Its backing storage is an operator decision: local disk, mounted filesystem or another durable host path.

The deployment derives its explicit runtime inputs from that root. At minimum, production needs persistent locations for:

- Server configuration;
- pending proposal state;
- operational logs;
- deployment controller state/evidence;
- tunnel configuration and credentials;
- the installed tunnel-client binary when it is operator-supplied.

The product does not require a source checkout or a private repository inside either container.

### Empty root

An empty persistent root is a supported first-run condition. REACH starts in setup mode: the data plane stays unavailable until the operator completes the initial configuration through the private administrative UI.

### Pre-seeded root

An operator may populate the persistent root from existing backup/recovery material before starting REACH. This is deployment/bootstrap behavior, not a public-product dependency.

## Secrets and rotation

Secrets stay outside the images and public repository. They are mounted into the relevant service from the persistent runtime material.

For tunnel credential rotation, replace the credential in the operator's persistent source, refresh the runtime copy if needed, and restart/redeploy only `reach-tunnel`. No `reach-server` image rebuild is required.

## CI/CD

The canonical production path is:

```text
validation -> Build Release -> Deploy Production
```

`Deploy Production` runs automatically after the release succeeds. `Rollback Production` remains manual.

On a Task branch (`feature/task-*`) the same validation and `Build Release` run for that pipeline's exact SHA, and `Deploy Candidate` runs automatically, with no button, only after `Build Release` passes (it needs every validation job, so a failed validation never exposes it). It deploys through the same `deploy/prod/deploy.mjs` transaction, `production` resource group, evidence and rollback, for live acceptance before merge. It never runs for a tag.

`deploy/prod/deploy.mjs` is the only deployment transaction owner. It validates required external inputs before building/starting and records known-good deployment state for rollback.

## Operational validation

A production rollout is accepted only when:

- the Server is healthy;
- running build id and repository commit match the release;
- the protected MCP data plane responds as expected;
- an authorized LAN Client can reach `/client`;
- an unauthenticated GET of the release manifest and the declared Linux/Windows Client artifacts succeeds on 8787 from another host, and nothing else under the release routes is served;
- the admin routes are not reachable through the MCP tunnel and nothing listens on 8788 or 8789;
- the Secure MCP Tunnel reaches MCP;
- restarting only the tunnel does not disturb the Server;
- restarting the full stack restores Server identity and tunnel reachability without manual repair.
