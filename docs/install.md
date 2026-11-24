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

The Server origin is passed explicitly: a script piped from `curl` cannot know where it came from, and nothing is guessed. Prerequisites: Linux x86_64, systemd, `curl`, `tar` and Node >= 24 on root's `PATH`. The installer reads the release manifest from that origin, selects the one `client`/`linux`/`x64` artifact, downloads it from its relative `download_path` (no redirect is followed, so the origin cannot change), verifies size and SHA-256, then installs it with the low-level installer shipped inside the archive. It creates the `reach-mcp` system account (no login) and `/var/lib/reach-mcp-client`, writes a `0600` bootstrap there holding only the endpoint `ws://<origin>/client` and one physical root, `/var/lib/reach-mcp-client/root` by default. `--root <abs-dir>` may point at any valid absolute operator-selected root, including `/` when the operator intentionally wants to expose the whole filesystem. `--root /` prints a WHOLE DISK warning and stops unless `--allow-whole-disk` is also given; any other root, however shallow, is accepted. Before it creates the account, the state directory, the download or the unit, the installer proves that the service user can run the exact Node it found: an existing `reach-mcp` account runs `node -v` itself (`runuser`), and an account that does not exist yet is stood in for by an unprivileged identity with no groups (`setpriv`, uid 65534), so nothing is created for the check. If a parent directory is not traversable for that user (a Node inside a private home, the cause of systemd 203/EXEC), the installer stops with `Nothing was changed.` and asks for a system Node first on `PATH`. The installer then enables the `reach-mcp-client` service. The V1 endpoint is `ws://`, so the unit passes `--allow-insecure-ws` on purpose. The Client generates its own id and Ed25519 private key on first start and writes them to that bootstrap; the key never leaves the machine and no script sees it. The Client then appears as **Pending** in the Admin UI until an administrator Enables it. Re-running the installer replaces the runtime atomically and keeps the bootstrap, identity included; only the endpoint follows the origin you pass.

Windows:

```powershell
$env:REACH_SERVER_ORIGIN='http://REACH-SERVER'; irm http://REACH-SERVER/install.ps1 | iex
```

Run it in an elevated PowerShell (5.1 or later) on Windows x64. As on Linux, the Server origin is passed explicitly because a script piped to `iex` cannot know where it came from. No Node install is needed: the Windows Client archive carries its own pinned Node runtime (`runtime\node.exe`, SHA-256-checked when the release is built, and covered by the manifest hash of the archive). The script verifies the manifest-selected `client`/`win32`/`x64` archive (size and SHA-256, no redirect followed), writes a bootstrap with only `ws://<origin>/client` and one operator-selected root to `C:\ProgramData\REACH\Client` (the ACL allows only SYSTEM and Administrators; the default root is `C:\ProgramData\REACH\Client\root`). Path depth is not a safety rule: `REACH_ROOT` accepts any plain absolute drive path, such as `C:\scope`. A drive root such as `C:\` is valid when the operator chooses it, but the script prints a WHOLE DRIVE warning and stops unless `$env:REACH_ALLOW_WHOLE_DRIVE='1'` is also set; a drive root is stored as `C:\` (never the drive-relative `C:`) and is never removed by the uninstaller. The state and install directories must be a directory below the drive root, and an existing directory or Scheduled Task that is not REACH's is refused by ownership, not by depth. The install and uninstall scripts use the same two path grammars. It then installs to `C:\Program Files\REACH\Client` through the low-level installer shipped inside the archive and starts the `REACH Client` Scheduled Task as SYSTEM. The Client generates its own id and private key on first start and writes them to that bootstrap, which never leaves the machine; the Client then appears **Pending** until an administrator Enables it. Re-running keeps the identity and replaces the runtime atomically.

Uninstall (local, offline; the scripts ship inside the Client archive, so no second download or manifest change):

- Linux: `sudo sh /opt/reach-mcp-client/deploy/uninstall-linux.sh --state-dir /var/lib/reach-mcp-client`
- Windows (elevated): `powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Program Files\REACH\Client\deploy\uninstall-windows.ps1"`

Each installer prints the exact command for the paths it used. Uninstall is driven by an install receipt, `install-receipt.json` in the Client state directory, written only after a successful install. It holds no id, key or token: only the install, state and bootstrap paths, the effective root, the service/task identity and three ownership flags (the state directory, the root and, on Linux, the `reach-mcp` account), captured before the first change. Uninstall removes the REACH service/task (only one that runs the REACH launcher), the runtime, the bootstrap (and with it the Client's private key) and the receipt. The state directory and the root are removed only when the installer created them and they are empty; a custom `--root`/`REACH_ROOT`, anything not empty, an account that existed before and a foreign unit or task are never touched, and an install refuses to overwrite a foreign unit or task. Without a receipt nothing is guessed or deleted. Re-running uninstall is harmless. Uninstall never changes the Server: the Client stays listed there until an administrator removes it. Installing again after a full uninstall creates a new identity that registers as a new **Pending** Client. A rerun of the installer keeps the root of the first install, and a different `--root`/`REACH_ROOT` fails before any change: uninstall first.

Updating Clients (operations):

- Normal path: in the Admin UI, Clients, press **Update Client** (or `POST /admin/api/clients/<id>/update`). The Client downloads the Server's canonical build, verifies size and SHA-256, stages it, and a privileged half installed by the installer (a systemd path unit on Linux, the one-shot `REACH Client Update` task on Windows) reruns the installer, which re-verifies against a fresh manifest. Identity, bootstrap and roots are kept. Progress shows as staging, restarting or failed with a closed reason; a failed update leaves the previous installation running and is never cleared silently. No SSH and no host login.
- Updates are explicit: nothing updates in the background. Roll out one real Client at a time: confirm it is back **Online** and compatible, with the same identity and project mappings and one allowed operation working, before updating the next.
- One-time bootstrap: a Client installed before the update feature does not report `update_capable` and cannot be updated centrally. Run the installer once on that host (the commands above; the identity is kept). This is migration work, not the update path. Later builds update centrally. Proven live on scope-dev (Task #149): the rerun kept the Client id, fingerprint and its one project mapping, and the Client came back Online, compatible and `update_capable`. The installer's closing line still says the Client registers as Pending; for an existing, already Enabled Client that line does not apply.
- An **Incompatible** Client keeps only a management session: it can be updated but serves no project operations until it is compatible.

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

The release manifest (schema v2, owned by the release-manifest tooling; repository source is being migrated to TypeScript under Task #119) is the only discovery contract: each artifact declares `role`, `platform`, `os`, `arch`, `name`, `sha256`, `size_bytes` and `download_path`. Installers select by `role`/`os`/`arch` (currently `linux`/`x64` and `win32`/`x64`), never by filename or by parsing `platform`. `download_path` is relative (`/release/artifacts/<name>`) and is `null` for the Server archive, which is not publicly served. The manifest holds no origin, root, credential or other environment data.

Trust on first use (contract from [ADR-0005](decisions/ADR-0005-server-trust-identity-and-signed-release-metadata.md), runtime in Task #164): the installer pins the Server public key in the Bootstrap as `server_trust_key`. By default it takes that key from the Server origin you pass, which is trust on first use: it holds only on the V1 local/controlled network and does not authenticate that first HTTP fetch. To avoid it, pass `REACH_SERVER_TRUST_KEY` (the Server public key, obtained out of band); it then takes precedence and the fetched key must match. From then on the Client verifies the signed manifest and the Server handshake with the pinned key, refuses a signed envelope with a lower `release_epoch` (the epoch lives in the envelope, never in the manifest), and never switches key except through a rotation statement signed by the pinned key. Neither installer verifies a signature (Windows PowerShell 5.1 has no trustworthy Ed25519 and a downloaded runtime is never run just to verify itself): with an out-of-band key the Server identity is authenticated at the Client's first connection, while the pre-runtime HTTP download is not claimed to be authenticated, and every later update is verified by the installed Client against the pin. An operator-triggered update never replaces an existing pin. Re-running the installer keeps the pin; reinstalling after the Server key was lost is the recovery path. A Client installed before pinning exists pins once, on its first signed-handshake connection after it is updated.

The private key never leaves the Client. V1 does not require TLS/WSS, trusted-network auto-admission, manual bootstrap or end-user compilation.

See [architecture.md](architecture.md) for the full system contract and [production-deployment.md](production-deployment.md) for production topology.
