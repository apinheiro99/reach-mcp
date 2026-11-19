# Development environment

How to develop REACH and how to rebuild the development environment. The architecture itself lives in [architecture.md](architecture.md); this page does not restate it. Configuration is in [configuration.md](configuration.md), installation in [install.md](install.md).

## Toolchain

- Node.js 24 or newer. The product `engines` contract is `>=24`; a development environment may pin a newer concrete version (the reference environment uses Node 26) as long as it satisfies it. `corepack` is not shipped with Node 26 and is not required.
- TypeScript, ESM.
- npm (bundled with Node.js), Git, OpenSSH client, `curl`, `ca-certificates`.
- Debian 13 (trixie) with systemd is the documented development target. Other Linux distributions work for building.

## Source tree layout

One umbrella root, mirroring the GitLab group structure:

```
/reach/
  reach-mcp/       product source (this repository)
  reach-private/   private configuration and recovery (never published)
```

Keep one persistent copy of the source and do not duplicate repositories inside a container's local filesystem. Installed Client binaries are separate from the source checkout; see [architecture.md](architecture.md) and [install.md](install.md).

The repository is a native npm workspace with explicit package ownership under `packages/server`, `packages/client`, `packages/shared` and isolated `packages/legacy/git-compat`. The obsolete root bootstrap `src/` ownership has been removed.

## Current DEV environment

The reference environment is a Debian 13 Incus container managed with systemd:

- `/reach` is an Incus disk device backed by shared storage on the host, so the source survives rebuilding the container.
- Node comes from the pinned official tarball with its checksum verified, linked into `/usr/local/bin` (`node`, `npm`, `npx`) so non-login shells such as SSH commands and scheduled jobs find it.
- A systemd timer fetches the CI result tags (below) into the shared clones every 60 seconds. It fetches tags only: never branches, never the work tree.

## DEV runtime (Server and Client)

The DEV Server still runs directly from the source workspace with Node's built-in TypeScript support. The DEV Client now follows the machine-install contract: it runs the installed release artifact at `/opt/reach-mcp-client/reach-client.mjs`. Each process is composed in its existing runtime owner; systemd owns restarts and nothing in REACH supervises itself.

Server flags (runtime values only; projects, Clients, credentials, policies and logging settings come from the config file): `--config <file>`, `--proposal <file>`, `--logs <dir>`, `--port <n>`, `--build <id>`, and optionally `--host` (defaults to `127.0.0.1`) and `--repository-commit <id>`. Unknown, duplicate, missing or valueless flags and invalid ports exit with code 2 and a usage line that never repeats a value. With no usable config file the Server starts in setup mode: the admin routes work, and `/mcp`, `/health` and `/client` stay refused until the first configuration is saved there. The process prints one line, `reach-server listening port=<port>`, and stops cleanly on SIGTERM or SIGINT.

Client flags: `--bootstrap <file>`, `--build <id>` and the explicit DEV switch `--allow-insecure-ws`, which only enables the bootstrap option that accepts a `ws://` endpoint. The endpoint, Client id, credential and root anchors exist only in the bootstrap file (mode 0600), never on the command line or in a unit. The Client and the Server must be given the same `--build` value; that equality is the whole compatibility rule for now.

DEV units live in `deploy/dev/` (`reach-mcp-server.service`, `reach-mcp-client.service`). They run as the container's unprivileged `dev` user with `Restart=on-failure`, bind both Server listeners to loopback (the admin page has no login of its own, so reach it through an SSH tunnel) and use only these paths:

- `/reach/reach-private/runtime/server/config.json` and `/reach/reach-private/runtime/server/proposal.json`: the Server configuration and pending proposal;
- `/reach/reach-private/runtime/client/bootstrap.env`: the Client bootstrap;
- `/reach/reach-mcp/logs`: `reach.log` and `audit.log` with their rotated files.

Before starting the DEV Client, build/obtain the matching Client release artifact and install it with `deploy/client/install-linux.sh` into the machine-level install path. Then copy the repository unit files to `/etc/systemd/system/`, reload systemd and enable/start the services as required. The unit carries only the bootstrap path and build id; the credential stays inside the protected bootstrap file. Production Docker, tunnel and CD remain separate Story #10 work.

Production Server deployment is containerized and is a separate concern, see [install.md](install.md).

## Rebuilding the environment

The container definition (Incus profile plus cloud-init) is private provisioning material kept in `reach-private/provisioning/incus/`. To rebuild:

1. Create the container from that definition and start it; cloud-init does the rest, including the Node toolchain.
2. Wait for `cloud-init status` to report `done`.
3. Verify: `env -i PATH=/usr/local/bin:/usr/bin:/bin node -v` prints the pinned version, and `/reach` shows `reach-mcp` and `reach-private`.
4. Install dependencies and validate from the source tree:

```sh
cd /reach/reach-mcp
npm install
npm run validate
```

Recreating a container changes its SSH host key; remove the old entry from `known_hosts` before reconnecting.

## CI and result tags

Every branch push runs six blocking validation jobs (Public Release Check, Lint, Type Check, Automated Tests, Package Check and Release Check). Release Check builds and verifies the canonical Server/Linux-Client/Windows-Client release. A final `tag` stage then records the aggregate result as a Git tag on the tested commit, `vYYYY.MM.NNNNNN` for green and `vYYYY.MM.NNNNNN-fail` for red. The tagging belongs to REACH itself: the `tag` stage computes the tag from the pipeline and pushes it with plain `git`, so the repository validates, tags and builds without any external project, and it can be moved to another GitLab unchanged. A tag pipeline never reruns validation or tagging.

The tag stage needs one GitLab-side setting and no stored credential: the project setting that allows `CI_JOB_TOKEN` to push to this same repository.

This is CI only. Production deployment (CD) is separate, later work.
