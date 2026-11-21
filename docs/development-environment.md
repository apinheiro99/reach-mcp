# Development environment

This file documents only the REACH development environment. Architecture lives in [architecture.md](architecture.md); runtime configuration in [configuration.md](configuration.md); installation in [install.md](install.md).

## Toolchain

- Node.js >=24;
- TypeScript + ESM;
- npm + Git;
- Debian 13 is the reference DEV target.

## Source layout

```text
/reach/
  reach-mcp/       product source
  reach-private/   private runtime/provisioning data
```

The source tree is an npm workspace under `packages/server`, `packages/client`, `packages/shared` and isolated legacy compatibility code.

## DEV runtime

The Server runs from the source workspace. The Client uses the installed release artifact. systemd owns process restart; REACH does not supervise itself.

The Server uses the same V1 architecture as production:

- service plane on 8787;
- admin plane on 8788;
- direct Client **WS** runtime;
- Client-owned Ed25519 identity;
- unknown valid Clients register as **Pending**;
- a human must **Enable** before operational access;
- no trusted-network auto-admission;
- no TLS/WSS requirement in V1.

DEV may use an explicit insecure-WS switch because the V1 transport itself is WS. Manual DEV bootstrap compatibility may remain temporarily while migration work is incomplete, but it is not the canonical production installation path.

## Runtime paths

Reference private runtime state belongs under `/reach/reach-private/runtime/`. Source logs remain under the repository log path during development.

Do not copy Client private keys into Server or recovery state.

## Rebuilding DEV

Private Incus/cloud-init provisioning remains under `reach-private/provisioning/`.

After the container is rebuilt:

```sh
cd /reach/reach-mcp
npm install
npm run validate
```

Verify that `/reach` exposes both `reach-mcp` and `reach-private`.

## Disposable targets

Disposable Linux/Windows targets are test infrastructure only. They must start clean, contain no pre-existing REACH identity, and be reversible. Canonical installation behavior is defined by the installers and [install.md](install.md), not by test-target mechanics.

## CI

Branch pushes run the repository validation pipeline and release checks. Production deployment behavior is documented only in [production-deployment.md](production-deployment.md).
