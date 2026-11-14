# Development environment

Public, reusable prerequisites for developing REACH. Host-specific provisioning and recovery material is kept outside this repository.

## Toolchain

- Debian 13 (trixie) with systemd. Other Linux distributions work for building, but the documented development target is Debian.
- Node.js 24 or newer. The product `engines` contract is `>=24`; a development environment may pin a newer concrete version (the reference environment uses Node 26) as long as it satisfies it. `corepack` is not shipped with Node 26 and is not required.
- npm (bundled with Node.js), Git, OpenSSH client, `curl`, `ca-certificates`.
- `nfs-common` only if the source tree is mounted over NFS.

## Source tree layout

Mirror the GitLab group structure under one root:

```
/reach/
  reach-mcp/       product source (this repository)
  reach-private/   private recovery and configuration (never published)
```

Keep one persistent copy of the source. Do not duplicate the repositories inside a container's local filesystem.

## Runtime paths

| Path | Contents |
|---|---|
| `/etc/reach-mcp/reach.yaml`, `reach.env` | Server configuration and environment |
| `/etc/reach-mcp/client.yaml`, `client.env` | Client configuration and environment |
| `/var/lib/reach-mcp/` | Runtime state |
| `/var/log/reach-mcp/` | Logs |

Configuration and environment files hold real values and stay outside the repository; `.env.example` and `config/example.json` only show names and shapes. See [configuration.md](configuration.md).

## Services

Development services run under a dedicated non-root user, read their environment from `/etc/reach-mcp/`, and write only to the state and log directories above. The Server and Client runtimes and their unit files arrive in later versions.

## CI and result tags

Every branch push runs five blocking validation jobs (Public Release Check, Lint, Type Check, Automated Tests, Build Package). A final `tag` stage then records the aggregate result as a Git tag on the tested commit, `vYYYY.MM.NNNNNN` for green and `vYYYY.MM.NNNNNN-fail` for red. The tagging belongs to REACH itself: the `tag` stage computes the tag from the pipeline and pushes it with plain `git`, so the repository validates, tags and builds without any external project, and it can be moved to another GitLab unchanged. A tag pipeline never reruns validation or tagging.

The tag stage needs one GitLab-side setting and no stored credential: the project setting that allows `CI_JOB_TOKEN` to push to this same repository.

Scope boundary: this is CI only. Production deployment (CD) is a later, separate piece of work.
