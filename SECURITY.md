# Security

## Privacy

File content requested through REACH may be transmitted to ChatGPT and OpenAI as part of fulfilling the user's request. Do not authorize files you are not willing to share this way.

## Trust boundaries

- **ChatGPT to REACH Server:** reaches the Server over the OpenAI Secure MCP Tunnel using Streamable HTTP.
- **REACH Server to REACH Client:** Clients connect outbound to the Server over an authenticated persistent channel. A Client does not accept inbound connections for REACH.
- **Client to host:** the Server is the operational configuration authority, but each Client exposes only what falls inside the physical root anchors authorized locally on its host. The Client always applies the security invariants and refuses any root or policy it receives that escapes those anchors.

## What REACH protects

- Access is limited to explicitly configured project roots, inside the Client's local root anchors; paths outside them are refused.
- Clients are outbound-only: they open the connection to the Server and accept no inbound REACH connections.
- Secret-bearing files are not exposed through ordinary reads.
- There is no arbitrary shell execution.
- No real secret is stored in this repository, and logs and CI output must not echo secrets.

## What REACH does not guarantee

- It does not protect content once it has been delivered to ChatGPT or OpenAI.
- It is not a sandbox and not an arbitrary shell runner; it does not defend a host that is already compromised.
- It is pre-release software: the behavior above describes the design, and features land in later versions.

## Reporting a security issue

Do not open a public issue. Report privately to the maintainers through the contact channel listed on the repository's project page. Include the affected version, steps to reproduce and the impact. Please allow time for a fix before any public disclosure.
