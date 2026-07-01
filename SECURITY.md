# Security Policy

## Supported versions

The project is pre-1.0 stabilization; security fixes target the latest released
`1.x` line and the `main` branch.

| Version | Supported |
|---------|-----------|
| `1.x` (latest) | ✅ |
| `< 1.0` / older tags | ❌ |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
pull requests, or discussions.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability** to open a private advisory.
3. Include a description, affected version(s), reproduction steps, and impact.

You can expect an initial acknowledgement within a few days. Once a fix is
prepared, we will coordinate a release and disclosure, and credit reporters who
wish to be named.

## Scope

This project reads `directory.json` skill packs and serves their content over
MCP. Reports of particular interest include:

- **Path traversal** in local skill-path resolution.
- **SSRF / scope escape** in remote (`http(s)://`) skill fetching.
- Injection or unsafe handling of untrusted `directory.json` / JSON-RPC input.
- Exposure of secrets or filesystem paths in error messages.

Findings that only affect **transitive dependencies** are tracked via Dependabot
and `npm audit`; please still report anything you believe is exploitable in this
project's actual usage.
