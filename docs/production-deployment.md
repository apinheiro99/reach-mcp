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
   | internal Compose network, MCP only
   v
reach-server:8787/mcp

reach-server:8788/admin   <- private/local management boundary only
```

- `reach-server` owns the application.
- `reach-tunnel` owns only the Secure MCP Tunnel client.
- The tunnel publishes no host port.
- The Server does not depend on tunnel health.
- The tunnel waits until the Server data listener responds before it starts.
- Both services restart automatically through Compose.

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

An empty persistent root is a supported first-run condition. REACH starts in setup mode: the data plane remains unavailable until the operator completes the initial configuration through the admin UI.

This is the canonical clean-install test.

### Pre-seeded root

An operator may populate the persistent root from existing backup/recovery material before starting REACH. This is deployment/bootstrap behavior, not a public-product dependency.

## Secrets and rotation

Secrets stay outside the images and public repository. They are mounted into the relevant service from the persistent runtime material.

For tunnel credential rotation:

1. replace the credential in the operator's persistent source;
2. update/stage the runtime copy if the deployment uses a staging step;
3. restart/redeploy `reach-tunnel`.

No `reach-server` image rebuild is required.

## CI/CD

The canonical production path is:

```text
validation -> Build Release -> Deploy Production
```

`Deploy Production` runs automatically after the release succeeds. `Rollback Production` remains manual.

`deploy/prod/deploy.mjs` is the only deployment transaction owner. It validates required external inputs before building/starting and records known-good deployment state for rollback.

## Operational validation

A production rollout is accepted only when:

- the Server is healthy;
- running build id and repository commit match the release;
- the protected data plane responds as expected;
- the Secure MCP Tunnel reaches MCP;
- admin is not routed through the tunnel;
- restarting only the tunnel does not disturb the Server;
- restarting the full stack restores Server identity and tunnel reachability without manual repair.
