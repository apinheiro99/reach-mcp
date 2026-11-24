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
- Proven live (Task #165, 2026-11-24): the Server on build `v2026.11.000061` serves `/release/trust-key` and `/release/envelope`; `reach-mcp-dev` and then `scope-dev`, both **Incompatible** on build `v2026.11.000058`, were updated with **Update Client** one at a time. Each came back Online, compatible and on `000061` with the same Client id, Machine UUID, fingerprint and one project mapping, and a routed `fs_list`/`fs_read` worked before the next Client was touched. A legacy Client pins the Server key on its first signed-handshake connection: `scope-dev`'s bootstrap then holds `REACH_SERVER_TRUST_KEY` equal to the key the Server publishes and `REACH_ROTATION_GENERATION=0`. `REACH_RELEASE_EPOCH` and `REACH_RELEASE_DIGEST` appear only after a later update accepts a signed envelope. A wrong or missing published key (rerun, update, recovery without the out-of-band key) is proven only in installer sandboxes (`tests/install.test.ts`), never by touching the live pin or rotating the live Server key.
- Update result (Story #154): each update is an attempt with a Server-minted `update_id`. `restarting` only means the replacement was handed to systemd or the Scheduled Task; the outcome is the durable receipt `update/apply-result.json` (`applied`, or `failed` with reason `apply`) that the privileged apply step writes and the Client reports on every reconnect. A Client that is back Online, even on the target build, is not proof of success without that receipt, and a failed result is never cleared or retried by itself: press **Update Client** again for a new attempt. Writing the receipt on each platform and showing it in the Admin UI are the next Tasks of the Story.
- Apply files (Task #167), both in the Client state directory `update/`, same bytes on Linux and Windows: the Client writes `apply-request.json` (`schema_version`, `update_id`, `from_build`, `target_build`, `artifact_sha256`; temp file, fsync, rename) before it asks the platform, and never triggers if that write fails. `apply-update-linux.sh` (systemd, root) and `apply-update-windows.ps1` (Scheduled Task, SYSTEM) are the only authors of `apply-result.json`: the request line closed with `"state":"applied"`, or `"state":"failed","reason":"apply"` for any failure after the request is accepted (no staged archive, bad bootstrap, installer exit nonzero; the installer's swap semantics leave the previous install running). The result is written to a temp file, flushed and renamed over the previous one, then the request is removed; a write failure exits nonzero and never leaves or invents a result. A request that is missing or not the canonical one stops the wrapper before the installer with no result, because nothing can be correlated: the Server then keeps showing `restarting` until a later receipt. After every welcome the Client reads `apply-result.json` and reports it; a missing or invalid file reports nothing. The result carries no path, origin, secret or time, and a staged-archive cleanup never touches it.
- Commit before start (Task #167, correction): the terminal result is the commit point, so the updated Client must never start before it is on disk. Both wrappers run the installer with `REACH_NO_START=1` (the low-level installers then do the verified swap, unit and task registration but skip the Client restart/start, including the Windows rollback restarts); a normal install or manual rerun does not set it and starts the Client as before. Order on both platforms: installer swap, then the wrapper commits `apply-result.json`, then the wrapper restarts the Client (`systemctl restart reach-mcp-client.service`; on Windows stop then start the `REACH Client` task). The same restart follows a `failed` result, so a Client that was never stopped (verification failed before the swap) or the preserved previous install also reports it. `applied` means the verified swap is committed and the start was requested; if the start is refused the result is rewritten to `failed`/`apply`, still before any new Client could connect.
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

Trust on first use ([ADR-0005](decisions/ADR-0005-server-trust-identity-and-signed-release-metadata.md)): the installer pins the Server public key in the Bootstrap as `REACH_SERVER_TRUST_KEY`. The installers never verify a signature: they check the artifact only against the size and SHA-256 of the plain manifest (corruption, not authenticity), so a first install and a rerun without an installed Client are not cryptographically authenticated. By default it takes that key from the Server origin you pass, which is trust on first use: it holds only on the V1 local/controlled network and does not authenticate that first HTTP fetch. To avoid it, pass `REACH_SERVER_TRUST_KEY` (the Server public key, obtained out of band); it then takes precedence and the fetched key must match. From then on the installed Client runtime verifies the signed envelope (required for every central or later update, before the manifest is read) and the Server handshake with the pinned key, refuses a signed envelope with a lower `release_epoch` (the epoch lives in the envelope, never in the manifest), and never switches key except through a rotation statement signed by the pinned key. Neither installer verifies a signature (Windows PowerShell 5.1 has no trustworthy Ed25519 and a downloaded runtime is never run just to verify itself): with an out-of-band key the Server identity is authenticated at the Client's first connection, while the pre-runtime HTTP download is not claimed to be authenticated, and every later update is verified by the installed Client against the pin. An operator-triggered update never replaces an existing pin. Re-running the installer keeps the pin, its epoch and its generation; if the Server publishes a different key than the pinned one the rerun (or update) stops before changing anything. Replacing a pin is the explicit recovery only (Linux `--recover-trust`, Windows `$env:REACH_RECOVER_TRUST='1'`), and it needs `REACH_SERVER_TRUST_KEY` set to the new key obtained out of band; it is refused with an update. A Client installed before pinning exists pins once, on its first signed-handshake connection after it is updated.

The private key never leaves the Client. V1 does not require TLS/WSS, trusted-network auto-admission, manual bootstrap or end-user compilation.

See [architecture.md](architecture.md) for the full system contract and [production-deployment.md](production-deployment.md) for production topology.
