# AGENTS.md — mcp-skills-tool

This file contains context for AI coding agents working on `@igmarin/mcp-skills-tool`. Read this first before making any changes.

---

## Project Overview

`mcp-skills-tool` is a TypeScript-based Model Context Protocol (MCP) server that reads `directory.json` skill packs and dynamically exposes those skills as MCP resources and tools to AI coding agents.

It supports two runtime modes:
1. **Local / CLI** — stdio transport via Node.js (or Docker).
2. **Edge / Serverless** — HTTP/SSE transport via Cloudflare Workers or Pages Functions (using Hono).

The project was built using Test-Driven Development (TDD) with Vitest.

---

## Technology Stack

- **Runtime:** Node.js 20+
- **Language:** TypeScript 5.4+ (strict mode, ES2022, NodeNext module resolution)
- **MCP SDK:** `@modelcontextprotocol/sdk` v1.0.1
- **CLI Parsing:** `commander` v12.1.0
- **Validation:** `zod` v3.23.8
- **Testing:** `vitest` v4.1.8 with `@vitest/coverage-v8`
- **Linting:** `eslint` v9 with `typescript-eslint` v8
- **Local Execution:** `tsx` v4.7.2 (for `npm start`)

---

## Project Structure

```
├── src/
│   ├── index.ts           # CLI entrypoint (stdio transport, Commander args)
│   ├── cli.ts             # CLI bootstrap/lifecycle helpers (loadConfig, runCli, caching wrap)
│   ├── mcp-server.ts      # Core MCP server factory (resources, tools, handlers)
│   ├── parser.ts          # Zod schema + parser for directory.json config
│   ├── skill-source.ts    # Local/remote skill fetchers (scope confinement + ETag revalidation)
│   ├── cache.ts           # Injectable in-memory TTL cache wrapper for skill content
│   ├── worker.ts          # Cloudflare Worker Streamable HTTP transport + request handler
│   ├── mcp-server.test.ts # Unit tests for MCP server behavior
│   └── parser.test.ts     # Unit tests for config parsing
├── scripts/
│   ├── evaluate-review.js      # GitHub Actions helper to evaluate OpenCode bot feedback
│   └── evaluate-review.test.js # Unit tests for the review evaluator
├── dist/                  # Compiled JavaScript output (gitignored, built by tsc)
├── coverage/              # Vitest coverage reports (gitignored)
├── .git-hooks/
│   └── pre-commit         # Runs lint + test:coverage before every commit
├── .github/workflows/
│   ├── ci.yml             # Lint, test, coverage on push/PR
│   └── deepseek-review.yml # Automated AI PR review via DeepSeek API
├── package.json           # NPM manifest, scripts, dependencies
├── tsconfig.json          # TypeScript compiler config (strict, NodeNext, declaration emit)
├── vitest.config.ts       # Test config (globals, coverage thresholds at 70%)
├── eslint.config.js       # ESLint flat config (typescript-eslint recommended + custom rules)
└── Dockerfile             # Multi-stage build (node:20-alpine)
```

---

## Build and Development Commands

All commands are run via `npm`:

| Command | Description |
|---------|-------------|
| `npm install` | Install dependencies |
| `npm run build` | Compile TypeScript (`tsc`) to `dist/` |
| `npm start` | Run CLI locally via `tsx src/index.ts` |
| `npm test` | Run tests once (`vitest run`) |
| `npm run test:watch` | Run tests in watch mode |
| `npm run test:coverage` | Run tests with coverage report and threshold enforcement |
| `npm run lint` | Run ESLint across the project |
| `npm run setup-hooks` | Copy `.git-hooks/pre-commit` into `.git/hooks/` |

### CLI Usage

```bash
# Local file
node dist/index.js --config /path/to/skills-repo/directory.json

# Remote URL
node dist/index.js --config https://raw.githubusercontent.com/user/repo/main/directory.json
```

### Docker Usage

```bash
docker build -t igmarin/mcp-skills-tool .
docker run -i --rm -v /absolute/path/to/skills-repo:/skills igmarin/mcp-skills-tool --config /skills/directory.json
```

---

## Code Style Guidelines

Enforced by `eslint.config.js` (flat config):
- `@typescript-eslint/no-unused-vars`: error (args prefixed with `_` are ignored)
- `@typescript-eslint/no-explicit-any`: error (disabled in test files)
- `no-console`: **error** in `src/**/*.ts` (non-test), warn elsewhere — only `console.warn` / `console.error` (stderr) are allowed. On the stdio transport, `stdout` carries the JSON-RPC stream, so a stray `console.log`/`info`/`debug` in server code corrupts the protocol.
- `eqeqeq`: error (always use strict equality)
- `prefer-const`: error
- `curly`: error (always use braces)

TypeScript is configured with `strict: true`, `forceConsistentCasingInFileNames: true`, and `declaration: true`.

External data (e.g. `directory.json`) must be validated with Zod schemas before use. Do not cast `unknown` inputs directly.

---

## Testing Instructions

- **Framework:** Vitest with globals enabled.
- **Test files:** `src/**/*.test.ts`, `src/**/*.spec.ts`, `scripts/**/*.test.ts`, `scripts/**/*.spec.ts`.
- **Coverage provider:** v8.
- **Coverage thresholds (all 70%):** statements, branches, functions, lines.
- **Excluded from coverage:** `src/worker.ts`, `**/*.test.ts`, `**/*.spec.ts`.

Tests for MCP handlers use internal `_requestHandlers` access on the `Server` instance to invoke handlers directly. When mocking external dependencies, prefer injecting mock `fetchSkillContent` functions into `createMcpServer`.

Always run `npm run test:coverage` before committing. The pre-commit hook enforces this.

---

## Module Division

### `src/parser.ts`
Defines the Zod schema for `directory.json`:
- `DirectoryConfig` — `{ name, version, summary, skills: Record<string, Skill> }`, where a `Skill` is `{ path: string; name?: string; description?: string; tags?: string[]; version?: string }`. Only `path` is required; the metadata fields are all `.optional()` so path-only configs remain valid. The object is non-strict, so unknown keys are stripped.
- `parseDirectoryConfig(json: unknown)` — validates and returns typed config.

### `src/skill-source.ts`
Defines `SkillFetcher = (skillPath: string) => Promise<string>` and its two implementations, both dependency-injectable:
- `createLocalSkillFetcher(configDir, readFile?)` — reads skill files from disk, confined to `configDir` (rejects `../` traversal, absolute paths, null bytes, and empty paths before any read).
- `createRemoteSkillFetcher(configUrl, fetchImpl?)` — loads skills over HTTP(S), confined to the config URL's origin + directory prefix (mitigating SSRF / scope escape). It keeps a per-path record of the last `ETag` (falling back to `Last-Modified`) and body, sends `If-None-Match` / `If-Modified-Since` on subsequent fetches, and returns the stored body on a `304 Not Modified` (handled before the `!res.ok` branch, since 304 is not "ok").

### `src/cache.ts`
Exports `createCachingFetcher(inner, options?)` — an injectable in-memory TTL cache that wraps any `SkillFetcher`. Keyed by skill path: a fresh entry is returned without calling `inner` (hit); otherwise `inner` is called and the result stored with `expiresAt = now() + ttlMs` (miss). `SkillCacheOptions` are `{ ttlMs?, now? }`; `now` defaults to `Date.now` (inject a fake clock in tests to simulate expiry) and `ttlMs` defaults to `DEFAULT_CACHE_TTL_MS` (300_000). A non-positive `ttlMs` disables caching (the `inner` fetcher is returned unchanged). Rejections are never cached. Compiled to `dist/cache.js`, so worker/library consumers can import it directly.

### `src/mcp-server.ts`
Exports `createMcpServer(config, fetchSkillContent)` which returns an MCP `Server` instance advertising `capabilities: { resources: {}, tools: {}, prompts: {} }` with:
- **Resources:** `skill://<recordKey>` URIs mapped to skill markdown files. The resource `name`/`description` prefer the skill's optional `name`/`description` metadata, falling back to the record key and `Agent skill: <recordKey>`. `resources/list` is paginated per the MCP spec: entries are sorted by record key and sliced into pages of `RESOURCE_PAGE_SIZE` (exported, 50), returning an opaque base64 `nextCursor` (via `btoa`/`atob`, so it works on Node and Workers) only when more remain. An invalid/garbage cursor is rejected with an `McpError(ErrorCode.InvalidParams)`.
- **Resource templates:** `resources/templates/list` returns a single template `{ uriTemplate: "skill://{name}", name: "skill", description: "Access a skill's markdown by name", mimeType: "text/markdown" }` describing the skill URI space (resource templates ride the `resources` capability).
- **Prompts:** each skill is also a slash-command-style prompt. `prompts/list` returns one argument-less prompt per skill (`name` = record key, `description` = the skill's metadata description or `Agent skill: <recordKey>`, `arguments: []`) as a single page. `prompts/get` looks the skill up via `lookupSkill` (guarding `__proto__`), fetches its content via `fetchSkillContent(skill.path)`, and returns `{ description, messages: [{ role: "user", content: { type: "text", text: <content> } }] }`; an unknown name throws `McpError(ErrorCode.InvalidParams)` and a fetch failure logs to stderr (`console.error`) and throws a generic `Failed to load skill content for "<name>"` error (mirroring the resource-read handler).
- **Tools:** `list_skills`, `search_skills`, and `get_skill` for clients that prefer tool interaction. `list_skills` returns a structured text block: the pack `summary`, then one line per skill (`- <name>: <description> [tags: …]`) with optional metadata folded in; for very large packs it caps the listing at `LIST_SKILLS_MAX_ENTRIES` (exported, 50) and appends `... and N more; use search_skills to filter`. `search_skills` takes `{ query: string, tags?: string[] }` (validated with zod `.safeParse`; invalid args throw like `get_skill`), does a case-insensitive substring match of `query` against each skill's record key, `name`, `description`, and `tags` (optionally further restricted to skills carrying one of `tags`), and returns matching skills formatted like `list_skills` or a plain `No skills match "<query>"` result (not an error) when nothing matches.

### `src/cli.ts`
Bootstrap and lifecycle helpers shared by the entrypoint, all dependency-injectable for testing:
- `loadConfig(source, deps?)` — resolves a local path or `http(s)://` URL, validates `directory.json`, and returns `{ config, fetchSkillContent }`. Expected failures are wrapped in `CliError`.
- `reportFatalError(error, log?)` — prints a `CliError` concisely (stack for unexpected errors) and returns exit code 1.
- `installSignalHandlers` / `shutdown` — SIGINT/SIGTERM graceful shutdown.
- `runCli(deps?)` — the CLI bootstrap: parses `--config`, `--no-cache`, and `--cache-ttl <seconds>` (Commander), calls `loadConfig`, wraps the fetcher with `createCachingFetcher` unless `--no-cache` is set (converting `--cache-ttl` seconds→ms; an invalid value raises `CliError`), then `createMcpServer` → `new StdioServerTransport()` → `server.connect` → `installSignalHandlers`, and logs the startup line to stderr. Every external constructor/function — including the caching `wrapFetcher` — is overridable via `RunCliDeps`, so the entrypoint wiring is unit-tested without real stdio or a real server.

### `src/index.ts`
Thin CLI entrypoint shim (with the `#!/usr/bin/env node` shebang): calls `runCli()` and maps a rejection to a process exit code via `reportFatalError`. All wiring lives in `runCli` (`src/cli.ts`).

### `src/worker.ts`
Exports `handleMcpRequest(request, mcpServerCreator)` for running the server on Cloudflare Workers/Pages Functions (or any Web Standard runtime) over the modern web-standard **Streamable HTTP** transport (`WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`). A single endpoint handles the full session lifecycle (initialize / message / `DELETE` teardown) keyed by the `mcp-session-id` header, and CORS headers are added to every response. Sessions are stored in a module-private in-memory `Map<string, WebStandardStreamableHTTPServerTransport>`. For production scaling, the code comments suggest migrating to Durable Objects.

### `scripts/evaluate-review.js`
A GitHub Actions helper that fetches bot comments/reviews on a PR, parses `[OPENCODE_VERDICT_METADATA]` blocks (or falls back to tag counting), determines a review state (`APPROVE`, `COMMENT`, `REQUEST_CHANGES`), and submits the review via the GitHub CLI (`gh`).

---

## CI / CD and Automation

### `ci.yml`
Runs on every push (except `main`) and every PR:
1. Checkout
2. Setup Node.js 20 (with npm cache)
3. `npm ci`
4. `npm run lint`
5. `npm run test:coverage`

### `deepseek-review.yml`
Runs on non-draft PRs (ignoring markdown and workflow-only changes):
1. Invokes the OpenCode review action (`anomalyco/opencode/github@v1.15.13`) using `deepseek/deepseek-v4-flash`.
2. The bot reviews for type safety, MCP compliance, test robustness, and security.
3. A subsequent step runs `node scripts/evaluate-review.js` to parse the bot feedback and update the PR review state.

### Pre-commit Hook
Located at `.git-hooks/pre-commit`. It runs `npm run lint` and `npm run test:coverage` and blocks the commit if either fails. Install with `npm run setup-hooks`.

---

## Security Considerations

- All JSON inputs (config and incoming messages) are validated with Zod.
- Local file paths are resolved with `path.resolve` to mitigate traversal issues.
- The Docker image uses `node:20-alpine` and a multi-stage build to minimize attack surface.
- No secrets or API keys are present in source files. Environment-sensitive data is read from `process.env`.
- The `no-console` ESLint rule discourages accidental `console.log` leakage in production code.

---

## Deployment Notes

- **NPM Package:** The package is published as `@igmarin/mcp-skills-tool`. `dist/` contains compiled JS and `.d.ts` declarations.
- **Docker:** Multi-stage Dockerfile copies `dist/` into a production `node:20-alpine` image with only production dependencies.
- **Cloudflare Workers:** Import `handleMcpRequest` and `createMcpServer` from the package. Provide your own `directory.json` loader and `fetchSkillContent` implementation.
