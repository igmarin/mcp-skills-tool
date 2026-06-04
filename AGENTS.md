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
│   ├── mcp-server.ts      # Core MCP server factory (resources, tools, handlers)
│   ├── parser.ts          # Zod schema + parser for directory.json config
│   ├── worker.ts          # Cloudflare Worker SSE transport + request handler
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
│   └── kimi-code-review.yml # Automated AI PR review via PR-Agent + Kimi (OpenRouter)
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
- `no-console`: warn (only `console.warn` and `console.error` allowed in production code)
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
- **Excluded from coverage:** `src/index.ts`, `src/worker.ts`, `**/*.test.ts`, `**/*.spec.ts`.

Tests for MCP handlers use internal `_requestHandlers` access on the `Server` instance to invoke handlers directly. When mocking external dependencies, prefer injecting mock `fetchSkillContent` functions into `createMcpServer`.

Always run `npm run test:coverage` before committing. The pre-commit hook enforces this.

---

## Module Division

### `src/parser.ts`
Defines the Zod schema for `directory.json`:
- `DirectoryConfig` — `{ name, version, summary, skills: Record<string, { path }> }`
- `parseDirectoryConfig(json: unknown)` — validates and returns typed config.

### `src/mcp-server.ts`
Exports `createMcpServer(config, fetchSkillContent)` which returns an MCP `Server` instance with:
- **Resources:** `skill://<name>` URIs mapped to skill markdown files.
- **Tools:** `list_skills` and `get_skill` for clients that prefer tool interaction.

### `src/index.ts`
CLI entrypoint using Commander. Parses `--config <path|url>`, resolves local or remote paths, fetches `directory.json`, builds the MCP server, and connects it to `StdioServerTransport`.

### `src/worker.ts`
Exports `handleMcpRequest(request, mcpServerCreator)` and `CloudflareWorkerSseTransport` for running the server on Cloudflare Workers/Pages Functions over SSE. Sessions are stored in an in-memory `Map<string, CloudflareWorkerSseTransport>`. For production scaling, the code comments suggest migrating to Durable Objects.

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

### `kimi-code-review.yml`
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
