# Install

## Current state

REACH is in development (pre-alpha). It is not ready for general installation, and the repository may be public before it is. Nothing here is a supported public installation path yet. The conditions for calling a release usable are the usable-release gate in [architecture.md](architecture.md).

## Build from source (development)

This remains valid for development. Requirements: Node.js 24 or newer, npm, Git.

```sh
git clone <repository-url> reach-mcp
cd reach-mcp
npm install
npm run validate
```

`npm install` is reproducible: it uses `package-lock.json`. The toolchain, source layout and how to rebuild the dev environment are in [development-environment.md](development-environment.md).

`git clone` is acceptable for development, but it is not necessarily the final installation contract.

## Planned distribution

- **Server:** a containerized deployment from a built image. Production does not need Git metadata or a working checkout.
- **Client:** a Node/TypeScript artifact with a simple install flow for Linux and Windows (systemd on Linux, a native Windows service or scheduled start on Windows). A native `.exe` or ELF is not required for the MVP.

These do not exist yet, and no public install commands are published until they do.

## Upgrade

Upgrade is always explicit: deploy the new artifact, restart, verify health. REACH never upgrades itself.

## Configuration

See [configuration.md](configuration.md).
