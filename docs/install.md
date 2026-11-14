# Install

REACH is pre-release; there is nothing to deploy yet. This page covers the development baseline.

## Requirements

- Node.js 24 or newer (the `engines` field enforces it).
- npm (bundled with Node.js).
- Git.

## Build from source

```sh
git clone <repository-url> reach-mcp
cd reach-mcp
npm install
npm run lint
npm run typecheck
npm run build
```

`npm install` is reproducible: it uses `package-lock.json`.

## Configuration

Copy `.env.example` and `config/example.json` to a private location outside the repository and fill in real values there. Never commit real values. See [configuration.md](configuration.md).

## Not covered yet

Server and Client runtime, tunnel wiring, containers and service units arrive in later versions.
