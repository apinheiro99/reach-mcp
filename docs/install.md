# Install

REACH is pre-alpha. End users consume prebuilt artifacts; source checkout is for development only.

## Development from source

Requirements: Node.js 24+, npm and Git.

```sh
git clone <repository-url> reach-mcp
cd reach-mcp
npm install
npm run validate
```

## Server installation

Canonical distribution:

- prebuilt Server image;
- `deploy/prod/compose.yaml`;
- root `.env.example`;
- local `.env` (ignored by Git);
- one installation-specific persistent path, `REACH_PRIVATE_PATH`, mounted as `/reach-private`.

Normal install:

```sh
git clone <repository-url>
cd <repository>
cp .env.example .env   # then set REACH_IMAGE, REACH_PRIVATE_PATH and the other values
docker compose --env-file .env -f deploy/prod/compose.yaml up -d
```

Update:

```sh
docker compose --env-file .env -f deploy/prod/compose.yaml pull
docker compose --env-file .env -f deploy/prod/compose.yaml up -d
```

Keep `REACH_PRIVATE_PATH` the same across updates: that path is what preserves the data. The persistent root must survive container recreation. REACH must fail clearly rather than silently fall back to ephemeral storage.

## Client installation

The Server exposes the canonical install commands. `http://REACH-SERVER/` is a minimal discovery page that shows exactly these commands for the address you used, and only for the installers the Server can actually serve right now; `/install.sh` and `/install.ps1` are the fixed download routes, served from the Server's release artifacts by those two exact names (a missing installer answers 404 and is not advertised). The page needs no login and no Admin access and works in setup mode.

Linux:

```sh
curl -fsSL http://REACH-SERVER/install.sh | sudo sh -s -- --server-origin http://REACH-SERVER
```

The Server origin is passed explicitly: a script piped from `curl` cannot know where it came from, and nothing is guessed. Prerequisites: Linux x86_64, systemd, `curl`, `tar` and Node >= 24 on root's `PATH`. The installer reads the release manifest from that origin, selects the one `client`/`linux`/`x64` artifact, downloads it from its relative `download_path` (no redirect is followed, so the origin cannot change), verifies size and SHA-256, then installs it with the low-level installer shipped inside the archive. It creates the `reach-mcp` system account (no login) and `/var/lib/reach-mcp-client`, writes a `0600` bootstrap there holding only the endpoint `ws://<origin>/client` and one physical root, `/var/lib/reach-mcp-client/root` by default (never `/`; `--root <abs-dir>` serves a real project directory instead), and enables the `reach-mcp-client` service. The V1 endpoint is `ws://`, so the unit passes `--allow-insecure-ws` on purpose. The Client generates its own id and Ed25519 private key on first start and writes them to that bootstrap; the key never leaves the machine and no script sees it. The Client then appears as **Pending** in the Admin UI until an administrator Enables it. Re-running the installer replaces the runtime atomically and keeps the bootstrap, identity included; only the endpoint follows the origin you pass.

Windows:

```powershell
$env:REACH_SERVER_ORIGIN='http://REACH-SERVER'; irm http://REACH-SERVER/install.ps1 | iex
```

Run it in an elevated PowerShell (5.1 or later) on Windows x64. As on Linux, the Server origin is passed explicitly because a script piped to `iex` cannot know where it came from. No Node install is needed: the Windows Client archive carries its own pinned Node runtime (`runtime\node.exe`, SHA-256-checked when the release is built, and covered by the manifest hash of the archive). The script verifies the manifest-selected `client`/`win32`/`x64` archive (size and SHA-256, no redirect followed), writes a bootstrap with only `ws://<origin>/client` and one narrow root to `C:\ProgramData\REACH\Client` (the ACL allows only SYSTEM and Administrators; the default root is `C:\ProgramData\REACH\Client\root`, never a drive root), installs to `C:\Program Files\REACH\Client` through the low-level installer shipped inside the archive, and starts the `REACH Client` Scheduled Task as SYSTEM. The Client generates its own id and private key on first start and writes them to that bootstrap, which never leaves the machine; the Client then appears **Pending** until an administrator Enables it. Re-running keeps the identity and replaces the runtime atomically.

Installer contract:

1. detect platform/architecture;
2. read the Server release manifest;
3. select the one `client` artifact whose `os`/`arch` match and download it from its relative `download_path` under the Server origin used to fetch the manifest;
4. verify SHA-256;
5. install the native service;
6. generate Client-owned Ed25519 identity locally;
7. register with the Server as **Pending**;
8. wait for human **Enable** through the Admin UI/API;
9. connect over **WS** and prove the private key.

The release manifest (schema v2, owned by `scripts/release/manifest.mjs`) is the only discovery contract: each artifact declares `role`, `platform`, `os`, `arch`, `name`, `sha256`, `size_bytes` and `download_path`. Installers select by `role`/`os`/`arch` (currently `linux`/`x64` and `win32`/`x64`), never by filename or by parsing `platform`. `download_path` is relative (`/release/artifacts/<name>`) and is `null` for the Server archive, which is not publicly served. The manifest holds no origin, root, credential or other environment data.

The private key never leaves the Client. V1 does not require TLS/WSS, trusted-network auto-admission, manual bootstrap or end-user compilation.

See [architecture.md](architecture.md) for the full system contract and [production-deployment.md](production-deployment.md) for production topology.
