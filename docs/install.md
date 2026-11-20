# Install

## Current state

REACH is still pre-alpha, but the repository now produces installable release artifacts. Public production deployment is not yet declared generally available, but the repository now contains the validated production Server image/Compose/CD reference path.

## Build from source (development)

Requirements: Node.js 24 or newer, npm and Git.

```sh
git clone <repository-url> reach-mcp
cd reach-mcp
npm install
npm run validate
```

Development uses the npm workspace source tree. A source checkout is not the Client installation contract.

## Release artifacts

One release build uses one opaque build id for Server and Client:

```sh
npm run release -- --build-id <build-id> --out <release-dir>
node scripts/release.mjs verify --out <release-dir>
```

The release directory contains:

```text
artifacts/
  manifest.json
  reach-client-linux-x64.tgz
  reach-client-win32-x64.zip
server/
  reach-server-linux-x64.tgz
```

`manifest.json` records the repository commit, the shared Server/Client build id, exact compatibility, and the SHA-256/size of every final artifact. Manifest schema v1 requires exactly those three runtime artifacts.

## Client installation

A REACH Client is installed once per machine, not once per project. Normal installation is zero-touch from an authorized target-host agent: the installer obtains and verifies the canonical artifact, the Client generates its own `client_id` and Ed25519 keypair locally, enrollment sends only the public key to the Server, protected local state is created automatically, the service is installed, and the persistent outbound connection is proven. The Client private key never leaves the machine.

### Linux

Default install directory: `/opt/reach-mcp-client`.

The supported normal path is one operator instruction executed through an authorized agent with shell access to the target host. That agent resolves the Server endpoint from deployment/private defaults or explicit invocation context, downloads and verifies `reach-client-linux-x64.tgz`, creates protected local identity/state, enrolls automatically, installs the runtime and systemd service, starts it, and verifies connection. The operator may use a temporary Claude Code/SSH workstation container to drive that remote shell workflow; that container is tooling only and is not part of the REACH runtime. The low-level artifact installer remains a building block, not the human workflow.

`--install-dir` may explicitly override the default. Insecure `ws://` remains an explicit development/test choice; normal secure deployments use the configured transport policy.

### Windows

Default install directory: `C:\\Program Files\\REACH\\Client`.

Windows follows the same zero-touch onboarding contract as Linux: one authorized target-host action resolves/downloads/verifies the canonical Windows artifact, creates the Client identity and protected local state, enrolls automatically, installs the machine-level service/task, starts it and verifies connection. Platform-specific packaging differs; identity, admission, policy and operator experience do not.

`-InstallDir` may explicitly override the default. Native Windows execution still requires real-host proof before general availability.

## Server distribution

The Server release artifact is self-contained and does not require Git/workspace links. The production reference deployment is one Compose project (`reach`) with separate `reach-server` and `reach-tunnel` services, controlled CD and explicit rollback. See [production-deployment.md](production-deployment.md).

The Server uses two ports: 8787 for `/mcp`, `/client`, `/health` and the read-only release downloads under `/release/...`, and 8788 for the private Web UI/admin (host loopback by default). The OpenAI MCP tunnel routes only `/mcp` on 8787.

## Upgrade

Upgrade is always explicit: obtain/build the intended release, verify it, replace the installed/deployed artifact, restart, and verify health. Because MVP compatibility is exact (`client_build == server_build`), upgrading the Server can temporarily leave older Clients offline until they are explicitly upgraded. REACH never upgrades itself silently and does not add version negotiation to hide that consequence.

## Configuration

See [configuration.md](configuration.md).