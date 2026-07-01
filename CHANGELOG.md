# Changelog

All notable changes to `@igmarin/mcp-skills-tool` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Release dates are assigned when a version is tagged.

## Versioning policy

Semantic Versioning applies to this package's **public API**, defined as:

- **CLI** — the `mcp-skills-tool` binary and its documented options (`--config <path|url>`).
- **Library exports** — `createMcpServer` and `handleMcpRequest`, and their documented type signatures.
- **Configuration** — the `directory.json` schema accepted by the server.
- **MCP surface** — the `skill://<name>` resource URIs and the `list_skills` / `get_skill` tools exposed to clients.

Anything else — internal helpers, transport implementation details, the compiled
`dist/` layout, and test utilities — is **not** part of the public API and may
change in minor or patch releases.

## [1.0.0] - Unreleased

Initial public release.

### Added
- MCP server that reads `directory.json` skill packs and exposes each skill as a `skill://<name>` resource (`text/markdown`).
- `list_skills` and `get_skill` tools for clients that prefer tool interaction over resources.
- Dual transport: stdio (CLI via `mcp-skills-tool --config <path|url>`, runnable through Node or Docker) and an edge/serverless transport for Cloudflare Workers / Pages Functions.
- Local and remote (`http(s)://`) `directory.json` support, with relative resolution of skill paths against the config location.
- Zod validation of the `directory.json` configuration at the input boundary.
- Graceful CLI lifecycle: SIGINT/SIGTERM close the server and exit cleanly, and expected startup failures (missing/invalid config) print a concise message with a non-zero exit instead of a raw stack trace.
- Packaging that publishes the compiled `dist/` only, a `tsc --noEmit` type-check gate in CI and the pre-commit hook, and an MIT license.

### Changed
- Edge/serverless transport migrated to the modern web-standard **Streamable HTTP** transport (`WebStandardStreamableHTTPServerTransport`). `handleMcpRequest` now serves the full session lifecycle (initialize / message / teardown) on a single endpoint via `mcp-session-id`, and adds CORS headers to every response.
- Enabled type-aware ESLint for non-test `src/**/*.ts` (via typescript-eslint's `projectService`) with `@typescript-eslint/no-floating-promises`, `no-misused-promises`, and `await-thenable` as errors, so async bugs like unhandled promises are caught at lint time.
- MCP server tests now exercise a real in-memory `Client`↔`Server` round-trip over `InMemoryTransport` instead of reaching into the SDK's private `_requestHandlers`, so they validate the actual request/response flow (internal/test-only).

### Removed
- Deprecated hand-rolled SSE edge transport (`CloudflareWorkerSseTransport`) and the `activeTransports` export.

[1.0.0]: https://github.com/igmarin/mcp-skills-tool/releases/tag/v1.0.0
