# REACH MCP

**Remote Environment Access & Context Hub.** REACH gives ChatGPT Web controlled access to explicitly authorized files and project environments through one MCP endpoint.

> Status: bootstrap. This repository currently holds the project baseline only. Protocol and runtime features are not implemented yet.

## Privacy disclosure

**File content that ChatGPT requests through REACH may be transmitted to ChatGPT and OpenAI as part of fulfilling your request.** Only expose projects and files you are willing to share this way. See [SECURITY.md](SECURITY.md).

## How it fits together

```
ChatGPT Web
    |
OpenAI Secure MCP Tunnel
    |
REACH Server
    |
authenticated persistent outbound client channels
    |
REACH Clients
    |
explicitly configured project roots
```

Each Client decides what its host exposes. Server requests never widen what a Client's local policy allows. Details: [docs/architecture.md](docs/architecture.md).

## What REACH is not

Not SSH, not an arbitrary shell runner, not a secrets manager, not generic remote administration, not a container orchestrator and not a database-backed control plane.

## Requirements

Node.js 24 or newer. See [docs/install.md](docs/install.md).

## Development

```sh
npm install
npm run lint
npm run typecheck
npm run build
```

Configuration uses placeholders in `.env.example` and `config/example.json`. Real values are never committed to this repository. See [docs/configuration.md](docs/configuration.md).

## License

MIT. See [LICENSE](LICENSE).
