# Configuration

Real configuration is never committed to this repository.

## Files in this repository

- `.env.example`: environment variable names and placeholder shapes only. Names are provisional until the protocol is fixed.
- `config/example.json`: a sanitized example of a Client configuration (identity, authorized project roots, local policy).

## Using them

1. Copy both files to a private location outside the repository.
2. Replace placeholders with real values there.
3. Point REACH at the private copies through explicit paths or environment wiring.

## Rules

- No real secret, key or certificate is committed here, in examples, tests or documentation.
- Logs and CI output must not print secret values.
- Project roots are explicit; there is no default root.
