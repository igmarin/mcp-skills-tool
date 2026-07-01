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
- **MCP surface** — the `skill://<name>` resource URIs, the `skill://{name}` resource template, the `list_skills` / `search_skills` / `get_skill` tools, and the per-skill prompts exposed to clients.

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
- Registry discoverability manifests at the repo root: `server.json` (official MCP registry descriptor, validated against the `2025-12-11` `server.schema.json` — reverse-DNS name `io.github.igmarin/mcp-skills-tool`, npm/stdio package launch, required `--config` package argument) and `smithery.yaml` (Smithery stdio launch descriptor with a `configSchema` for `config`/`cacheTtl`/`noCache` and an `npx`-based `commandFunction`). A matching `mcpName` in `package.json` lets the MCP registry verify npm ownership. Both files live in the source tree for registries to read and are not shipped in the npm tarball.
- Optional per-skill metadata in `directory.json` (`name`, `description`, `tags`, `version`), surfaced in `resources/list` (resource `name`/`description`) and in the `list_skills` tool output (name, description, tags, prefixed with the pack `summary`). All fields are optional, so existing path-only configs are unchanged.
- In-memory skill-content caching keyed by skill path with a configurable TTL (default 300s), so repeated `resources/read` / `get_skill` calls avoid re-fetching. Remote packs additionally revalidate cheaply after expiry via `ETag`/`If-None-Match` (falling back to `Last-Modified`/`If-Modified-Since`), reusing the stored body on a `304 Not Modified`. Configure with `--cache-ttl <seconds>` or opt out with `--no-cache`; errors are never cached.
- `search_skills` tool that filters skills by a case-insensitive substring `query` matched against each skill's record key, `name`, `description`, and `tags`, with an optional `tags` argument to further restrict matches; a query with no matches returns a plain "no skills match" message rather than an error.
- Cursor-based pagination for `resources/list` per the MCP spec: resources are returned in deterministic pages with an opaque `nextCursor` when more remain (absent on the last page), and an invalid cursor is rejected as an `InvalidParams` error. The `list_skills` tool output is capped for very large packs and flags the remainder, pointing at `search_skills`. Small packs are unaffected (single page, no cursor, full listing).
- Skills are also exposed as MCP **prompts** (`prompts/list` / `prompts/get`, slash-command style): one argument-less prompt per skill whose `prompts/get` result carries the skill markdown as a single `user` text message. Unknown prompt names are rejected as `InvalidParams`, and a content-fetch failure surfaces a generic error. A **resource template** (`resources/templates/list`) advertises the `skill://{name}` URI space, and the server now negotiates the `prompts` capability.
- Runnable example skill pack under `examples/skills-pack/` (a `directory.json` with two metadata-rich skills — `hello-world` and `code-review` — plus their `SKILL.md` files) that the README references for a first end-to-end run.
- `inspect` and `inspect:dev` npm scripts that launch the official `@modelcontextprotocol/inspector` against the built server and TypeScript source, respectively, using the bundled `examples/skills-pack/directory.json`.
- Documentation for the MCP Inspector dev/debug workflow in `README.md` (stdio launch, resource/tool/prompt exploration, and Streamable HTTP transport notes) and `CONTRIBUTING.md` (Everyday commands table).
- Expanded README documentation: ready-to-paste stdio client-setup blocks for Claude Desktop, Cursor, VS Code (GitHub Copilot), and Windsurf; a consolidated `directory.json` schema reference (every top-level and per-skill field, types, and an annotated example); and a troubleshooting section mapping the actual CLI error messages (config not found / invalid JSON / schema validation / cache-ttl / skill path or URL scope escapes / non-OK fetch) to their cause and fix.
- Automated, provenance-signed npm release: a tag-triggered (`v*`) GitHub Actions workflow (`release.yml`) verifies the tag matches `package.json`, runs the full quality gate (lint → typecheck → test:coverage), builds, and publishes with `npm publish --provenance --access public`. A companion `publish-dryrun.yml` runs `npm publish --dry-run` on every pull request to catch packaging regressions without publishing.
- Hardened, multi-arch (`linux/amd64` + `linux/arm64`) Docker image published to GitHub Container Registry (`ghcr.io/igmarin/mcp-skills-tool`) on every `v*` tag via `docker.yml`. The runtime image now runs as the unprivileged `node` user (never root) and carries a `HEALTHCHECK` that validates the entrypoint is runnable (`node dist/index.js --version`, since the stdio server has no port to probe).
- Contributor scaffolding: GitHub issue templates (`bug_report.md`, `feature_request.md`, and a `config.yml` that disables blank issues and links to Discussions/Security), a pull request template (`.github/PULL_REQUEST_TEMPLATE.md`), and README status badges (CI, npm version, license, Codecov coverage).
- CI now emits an `lcov` coverage report (`vitest` `coverage.reporter: ["text", "lcov"]`) and uploads it to [Codecov](https://codecov.io/gh/igmarin/mcp-skills-tool) via a SHA-pinned `codecov/codecov-action` step in `ci.yml` (runs once on the Node 20 matrix leg, non-blocking, token-based; requires a `CODECOV_TOKEN` repo secret).
- `CODE_OF_CONDUCT.md` (Contributor Covenant v2.1), linked from `README.md` and `CONTRIBUTING.md`, so the project shows the GitHub community-standards Code of Conduct check.

### Changed
- Edge/serverless transport migrated to the modern web-standard **Streamable HTTP** transport (`WebStandardStreamableHTTPServerTransport`). `handleMcpRequest` now serves the full session lifecycle (initialize / message / teardown) on a single endpoint via `mcp-session-id`, and adds CORS headers to every response.
- Enabled type-aware ESLint for non-test `src/**/*.ts` (via typescript-eslint's `projectService`) with `@typescript-eslint/no-floating-promises`, `no-misused-promises`, and `await-thenable` as errors, so async bugs like unhandled promises are caught at lint time.
- MCP server tests now exercise a real in-memory `Client`↔`Server` round-trip over `InMemoryTransport` instead of reaching into the SDK's private `_requestHandlers`, so they validate the actual request/response flow (internal/test-only).
- Expanded `directory.json` parser tests to cover edge cases — empty skills record, non-string/missing skill `path`, stripped unknown top-level keys, wrong top-level field types, and non-record `skills` values — documenting the actual Zod schema behavior (internal/test-only).
- Raised Vitest coverage thresholds from 70% to 85% for statements, branches, functions, and lines; enforced by the pre-commit hook and CI (internal/test-only).
- CLI entrypoint bootstrap extracted into an injectable `runCli` (in `src/cli.ts`) so `src/index.ts` is a thin shim; the entrypoint wiring is now unit-tested and `src/index.ts` was removed from the coverage exclude list (internal/test-only).
- Edge/serverless transport is now covered by Vitest tests that drive `handleMcpRequest` through a real Streamable HTTP session (initialize → initialized → tools/list, DELETE teardown, missing/unknown session, unsupported method, and OPTIONS preflight); `src/worker.ts` was removed from the coverage exclude list (internal/test-only).

### Removed
- Deprecated hand-rolled SSE edge transport (`CloudflareWorkerSseTransport`) and the `activeTransports` export.

### Fixed
- Dropped the `./` prefix from the `bin` path in `package.json` so modern npm no longer strips the `mcp-skills-tool` command on publish (keeps `npx @igmarin/mcp-skills-tool` and the Docker/registry launch commands working).

[1.0.0]: https://github.com/igmarin/mcp-skills-tool/releases/tag/v1.0.0
