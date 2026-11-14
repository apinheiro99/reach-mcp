# Security

## Privacy

File content requested through REACH may be transmitted to ChatGPT and OpenAI as part of fulfilling the user's request. Do not authorize files you are not willing to share this way.

## Trust boundaries

- **ChatGPT to REACH Server:** reaches the Server over the OpenAI Secure MCP Tunnel using Streamable HTTP.
- **REACH Server to REACH Client:** Clients connect outbound to the Server over an authenticated persistent channel. A Client does not accept inbound connections for REACH.
- **Client to host:** each Client exposes only the project roots explicitly configured on its host. The Client's local policy is the final authority: if the Server asks for more than the policy allows, the stricter policy wins.

## What REACH protects

- Access is limited to explicitly configured project roots; paths outside them are refused.
- Secret-bearing files are not exposed through ordinary reads.
- No real secret is stored in this repository, and logs and CI output must not echo secrets.

## What REACH does not guarantee

- It does not protect content once it has been delivered to ChatGPT or OpenAI.
- It is not a sandbox and not an arbitrary shell runner; it does not defend a host that is already compromised.
- It is pre-release software: the behavior above describes the design, and features land in later versions.

## Reporting a security issue

Do not open a public issue. Report privately to the maintainers through the contact channel listed on the repository's project page. Include the affected version, steps to reproduce and the impact. Please allow time for a fix before any public disclosure.
