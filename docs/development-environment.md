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

Keep one persistent copy of the source and do not duplicate the repositories inside a container's local filesystem. `reach-mcp-client/` exists only on machines where the Client is installed; see [architecture.md](architecture.md) (runtime layout).

The target source layout is `packages/server`, `packages/client` and `packages/shared` in this single repository. The repository still holds the bootstrap tree (`src/`) until the implementation tasks introduce the packages.

## Current DEV environment

The reference environment is a Debian 13 Incus container managed with systemd:

- `/reach` is an Incus disk device backed by shared storage on the host, so the source survives rebuilding the container.
- Node comes from the pinned official tarball with its checksum verified, linked into `/usr/local/bin` (`node`, `npm`, `npx`) so non-login shells such as SSH commands and scheduled jobs find it.
- A systemd timer fetches the CI result tags (below) into the shared clones every 60 seconds. It fetches tags only: never branches, never the work tree.

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

Every branch push runs five blocking validation jobs (Public Release Check, Lint, Type Check, Automated Tests, Build Package). A final `tag` stage then records the aggregate result as a Git tag on the tested commit, `vYYYY.MM.NNNNNN` for green and `vYYYY.MM.NNNNNN-fail` for red. The tagging belongs to REACH itself: the `tag` stage computes the tag from the pipeline and pushes it with plain `git`, so the repository validates, tags and builds without any external project, and it can be moved to another GitLab unchanged. A tag pipeline never reruns validation or tagging.

The tag stage needs one GitLab-side setting and no stored credential: the project setting that allows `CI_JOB_TOKEN` to push to this same repository.

This is CI only. Production deployment (CD) is separate, later work.
