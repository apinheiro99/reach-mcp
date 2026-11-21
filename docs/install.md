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

The Server exposes the canonical install commands:

Linux:

```sh
curl -fsSL http://REACH-SERVER/install.sh | sudo sh
```

Windows:

```powershell
irm http://REACH-SERVER/install.ps1 | iex
```

Installer contract:

1. detect platform/architecture;
2. read the Server release manifest;
3. download the correct prebuilt Client artifact;
4. verify SHA-256;
5. install the native service;
6. generate Client-owned Ed25519 identity locally;
7. register with the Server as **Pending**;
8. wait for human **Enable** through the Admin UI/API;
9. connect over **WS** and prove the private key.

The private key never leaves the Client. V1 does not require TLS/WSS, trusted-network auto-admission, manual bootstrap or end-user compilation.

See [architecture.md](architecture.md) for the full system contract and [production-deployment.md](production-deployment.md) for production topology.
