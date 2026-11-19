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

A REACH Client is installed once per machine, not once per project. The bootstrap file is separate from the installed binaries and remains the operator-owned protected file containing endpoint, Client identity, credential and local physical root anchors.

### Linux

Default install directory: `/opt/reach-mcp-client`.

```sh
deploy/client/install-linux.sh \
  --archive <release-dir>/artifacts/reach-client-linux-x64.tgz \
  --bootstrap <absolute-protected-bootstrap-file> \
  --build <build-id> \
  --user <service-user> \
  --enable
```

`--install-dir` explicitly overrides the default. The installer stages/replaces the runtime and generates a systemd unit that runs the installed `reach-client.mjs`. `--allow-insecure-ws` exists only as an explicit DEV/test option.

### Windows

Default install directory: `C:\\Program Files\\REACH\\Client`.

```powershell
.\deploy\client\install-windows.ps1 \
  -Archive <release-dir>\artifacts\reach-client-win32-x64.zip \
  -Bootstrap <absolute-protected-bootstrap-file> \
  -Build <build-id>
```

`-InstallDir` explicitly overrides the default. The installer registers one machine-level Scheduled Task that starts Node with the installed `reach-client.mjs`. Native Windows execution of this installer remains to be proven on a Windows host; the current repository validation proves its structure and release layout only.

## Server distribution

The Server release artifact is self-contained and does not require Git/workspace links. The production reference deployment is one Compose project (`reach`) with separate `reach-server` and `reach-tunnel` services, controlled CD and explicit rollback. See [production-deployment.md](production-deployment.md).

The Server uses two ports: 8787 for `/mcp`, `/client`, `/health` and the read-only release downloads under `/release/...`, and 8788 for the private Web UI/admin (host loopback by default). The OpenAI MCP tunnel routes only `/mcp` on 8787.

## Upgrade

Upgrade is always explicit: obtain/build the intended release, verify it, replace the installed/deployed artifact, restart, and verify health. REACH never upgrades itself silently.

## Configuration

See [configuration.md](configuration.md).