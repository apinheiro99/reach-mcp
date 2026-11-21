# Development environment

This file documents only the REACH development environment. Architecture lives in [architecture.md](architecture.md); runtime configuration in [configuration.md](configuration.md); installation in [install.md](install.md).

## Toolchain

- Node.js >=24;
- TypeScript + ESM;
- **TypeScript-only first-party policy:** source, tooling and tests use `.ts`. Existing `.mjs` files are migration debt and must be converted; new `.mjs` files are not allowed unless TypeScript is technically impossible and the Product Owner explicitly approves the exception;
- npm + Git;
- Debian 13 is the reference DEV target.

## Source layout

```text
/reach/
  reach-mcp/       product source
  reach-private/   private runtime/provisioning data
```

The source tree is an npm workspace under `packages/server`, `packages/client`, `packages/shared` and isolated compatibility code. Runtime/domain code, repository tooling and tests are TypeScript. Any remaining `.mjs` file is tracked migration debt rather than an accepted parallel source style.

## DEV runtime

The former dedicated REACH DEV Server runtime is retired and is no longer part of the active operating topology. PROD is the canonical runtime for current integration, migration and dogfooding. Development still occurs from the source workspace and CI/tests/disposable targets remain valid engineering surfaces, but no always-on REACH DEV Server is required. If an isolated DEV runtime is ever needed again, it must be created deliberately rather than treated as an implicit dependency.

When an isolated development Server is intentionally started, it uses the same V1 architecture as production:

- service plane on 8787;
- admin plane on 8788;
- direct Client **WS** runtime;
- Client-owned Ed25519 identity;
- unknown valid Clients register as **Pending**;
- a human must **Enable** before operational access;
- no trusted-network auto-admission;
- no TLS/WSS requirement in V1.

The DEV unit starts the Server with `--dev-live-reload`: the process watches its own sources (polling file times, because `/reach` is a network share where `node --watch` never sees a change made from another machine), restarts itself, and systemd (`Restart=always`) starts it again; an already open Admin page reloads by itself (the page keeps one event stream open, receives a new process instance id after the restart and reloads once). Both are DEV only; a production process has neither the route nor the script. The unit keeps the Admin listener on loopback. To review the UI from the operator workstation, the private drop-in `reach-private/runtime/server/reach-mcp-server.lan-admin.conf` binds it to the LAN with `--admin-host` and `--admin-allow-from`, and the runtime refuses a non-loopback admin host without that peer list; no network address of the deployment is in public source.

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
