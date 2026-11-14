# Architecture

REACH has two roles, both Node.js and TypeScript (ESM).

## Roles

- **Server.** The single MCP endpoint that ChatGPT talks to. It receives requests over Streamable HTTP through the OpenAI Secure MCP Tunnel and routes them to Clients.
- **Client.** Runs next to the files it exposes. It opens an authenticated persistent outbound channel to the Server and serves only the project roots configured locally.

```
ChatGPT Web -> OpenAI Secure MCP Tunnel -> REACH Server
                                              ^  (outbound, authenticated)
                                              |
                                        REACH Clients -> configured project roots
```

## Principles

- **Local policy is sovereign.** A Client's own policy decides what is allowed. A Server request can only narrow it. If the Server asks for write and the Client permits read-only, the result is read-only.
- **Outbound only.** Clients dial the Server; hosts expose no new inbound port for REACH.
- **Explicit roots.** Nothing is reachable unless a project root is configured.
- **Read-only by default.** Read operations are annotated as read-only for ChatGPT.
- **Bounded behavior.** Search and listing operate under configurable limits.

## Repositories

- `reach-mcp` (this repository): product source, tests, build configuration, sanitized examples and documentation. Intended for public release after a clean publication process.
- A separate private repository holds real environment configuration and recovery material. It is never published and never required by this repository's source.

## Status

Bootstrap only. The protocol, Server and Client are implemented in later versions.
