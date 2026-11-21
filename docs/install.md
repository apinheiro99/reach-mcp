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
- root `compose.yaml`;
- root `.env.example`;
- local `.env`;
- one installation-specific persistent path, mounted as `/reach-private`.

Normal install:

```sh
git clone <repository-url>
cd <repository>
cp .env.example .env
docker compose up -d
```

Update:

```sh
docker compose pull
docker compose up -d
```

The persistent root must survive container recreation. REACH must fail clearly rather than silently fall back to ephemeral storage.

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
