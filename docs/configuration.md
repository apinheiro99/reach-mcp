# Configuration

How REACH is configured and operated. The reasons behind these rules are in [architecture.md](architecture.md); this page covers the practice. Development setup is in [development-environment.md](development-environment.md), installation in [install.md](install.md).

Real environment configuration and keys are never committed to the public repository. The deployed Server receives environment-owned values through persistent/private configuration paths; the backing storage location is an operator decision. Client private keys are never copied into Server or recovery configuration.

## Server

The Server is the operational configuration authority for logical projects, roots, access modes, allowlists, deny rules, limits, Client public keys and routing. It is not the owner of Client private keys.

- **File-backed.** Mutable Server configuration persists to one simple inspectable file under the deployment-provided persistent root. No database.
- **Private deployment defaults.** Environment-specific values such as Server address, trusted Client network, administrative IP/CIDR allowlist and initial onboarding defaults belong to private deployment configuration (for the owner's environment, REACH Private), never hardcoded public source.
- **Safe activation.** Changes activate atomically; an invalid configuration never replaces the last-known-good one.
- **Web UI administration.** The Web UI manages Clients, roots, modes, key rotation, proposals and operational visibility after installation. It is not required for first Client enrollment.
- **Administrative network boundary.** Port 8788 accepts only the configured trusted source IP/CIDR. The default value is environment-owned and normally matches the trusted network containing the development/operator machine. There is no universal hardcoded subnet.
- **Service plane.** Port 8787 owns MCP, Client WebSocket, health, release download and zero-touch enrollment. Client enrollment never requires access to 8788.

## AI-assisted changes

The Server has exactly two listeners. Port 8787 is the service plane and port 8788 is the administrative plane. The OpenAI Secure MCP Tunnel routes only `/mcp` on 8787. Client↔Server WebSocket traffic stays direct on the local/private network and is unrelated to the tunnel.

`ServerConfigStore` remains the single owner of mutable Server configuration. The browser, MCP proposal path and enrollment path are thin inputs into that owner; none maintains a parallel Client registry or policy copy.

Implemented proposal gating remains separate from Client enrollment: AI-originated configuration edits can remain pending for human approval. First Client enrollment is automatic under the configured trusted-network/onboarding policy and does not require UI data entry.

Operational logging and audit must record enrollment, key rotation, connect/disconnect and administrative outcomes without ever logging a Client private key, signature material, MCP bearer or protected file content.

## Clients

A Client is thin. Its protected local state owns:

- the Server endpoint;
- the `client_id`;
- the Ed25519 private key;
- the physical base roots this Client is ever allowed to expose.

The private key never leaves the Client. The Server stores only the matching public key and Server-owned logical project/policy configuration.

### Enrollment

Normal enrollment is zero-touch:

1. an authorized agent is told to access the target machine and install the Client;
2. the installer downloads and verifies the canonical platform artifact from the Server;
3. the Client generates its own `client_id` and Ed25519 keypair locally;
4. only the public key and non-secret enrollment metadata are sent to the Server over the service plane;
5. the Server auto-admits the Client according to the configured trusted-network/onboarding defaults and persists the public key;
6. the Client creates its protected local state automatically, including the private key and root anchors;
7. the Client opens one persistent WebSocket and proves possession of the private key by signing a fresh Server challenge;
8. the Server verifies the signature and marks the Client online.

The installer may propose the current working/project directory as the initial root. If that choice is not unambiguous, the normal installer may ask only for confirmation of the proposed root. Controlled write access initially remains limited to `temp/**` unless private deployment defaults explicitly choose otherwise.

### Key rotation

The administrative UI requests rotation; the connected Client generates a new Ed25519 keypair locally and sends only the new public key. The Server atomically replaces the stored public key, the Client reconnects and proves the new private key, and the old public key stops authenticating.

## Logs and persistence

Operational logs and the audit trail rotate at midnight or at a maximum size, with 5 days of retention by default; retention and size are configurable in the Web UI.

Log and private-configuration paths are deployment inputs, not public hardcoded product paths. The deployed Server persists its explicit config/proposal and log locations. An operator may pre-seed Server-side recovery material from the private configuration repository. Client protected local state is created by zero-touch onboarding and remains machine-local; it is never part of the release artifact or Server/private recovery repository.

## Rules

- No real secret, key or certificate is committed to the public repository, in examples, tests or documentation.
- Logs and CI output never print secret values or file contents.
- Project roots are explicit; there is no default root.
