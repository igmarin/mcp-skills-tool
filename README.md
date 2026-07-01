# MCP Skills Tool

[![CI](https://github.com/igmarin/mcp-skills-tool/actions/workflows/ci.yml/badge.svg)](https://github.com/igmarin/mcp-skills-tool/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@igmarin/mcp-skills-tool)](https://www.npmjs.com/package/@igmarin/mcp-skills-tool)
[![License: MIT](https://img.shields.io/npm/l/@igmarin/mcp-skills-tool)](LICENSE)
[![codecov](https://codecov.io/gh/igmarin/mcp-skills-tool/branch/main/graph/badge.svg)](https://codecov.io/gh/igmarin/mcp-skills-tool)

A versatile Model Context Protocol (MCP) server that reads `directory.json` skill packs (such as those used by Tessl) and dynamically exposes those skills as MCP resources, tools, and prompts to AI coding agents.

It supports running locally via **STDIO** (npm/npx or Docker) and hosting on the edge via **HTTP/SSE** (Cloudflare Workers/Pages Functions).

## Features
* **Standard-Compliant Resource Exposure**: Registers each skill defined in `directory.json` as a `skill://<name>` resource, with cursor-based pagination (`nextCursor`) so large packs are served in pages, plus a `skill://{name}` resource template.
* **Prompts**: Exposes each skill as a slash-command-style MCP prompt (`prompts/list`, `prompts/get`) for clients that consume skills as prompts.
* **Helper Tools**: Exposes `list_skills`, `search_skills`, and `get_skill` tools for clients that prefer tool interaction over resources.
* **Dual Transport**: Supports stdio transport for local use and a custom SSE stream transport for serverless Cloudflare Workers.
* **Flexibility**: Works with both local files and remote GitHub configuration paths.

---

## `directory.json` Schema Reference

A skill pack is described by a single `directory.json` file. The top-level fields (`name`, `version`, `summary`) describe the pack, and `skills` maps a **record key** to a skill entry. Each skill entry requires only a `path`; the remaining per-skill fields are **optional metadata** that lets agents understand a skill without fetching its content.

The file is validated with [Zod](https://zod.dev/) at load time (see `src/parser.ts`): unknown keys are stripped, and a schema violation aborts startup with a concise error (see [Troubleshooting](#troubleshooting)).

### Top-level fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | yes | Skill pack name; used as the MCP server name. |
| `version` | `string` | yes | Skill pack version; used as the MCP server version. |
| `summary` | `string` | yes | One-line pack summary; prepended to the `list_skills` output. |
| `skills` | `object` | yes | Map of `<recordKey>` → skill entry (see below). |

### Skill entry (each value under `skills`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | `string` | yes | Path to the skill's markdown, resolved relative to the config location. Local packs confine it to the config's directory; remote packs confine it to the config URL's origin + directory prefix. |
| `name` | `string` | no | Display name; used for the resource `name`, the `list_skills` line, and the prompt label (falls back to the record key). |
| `description` | `string` | no | Human-readable description; used for the resource `description`, `list_skills`, and the prompt description (falls back to `Agent skill: <recordKey>`). |
| `tags` | `string[]` | no | Tags; surfaced in `list_skills` and searchable via `search_skills`. |
| `version` | `string` | no | Per-skill version string. |

The **record key** (the object key under `skills`) is the skill's identity: the resource `uri` is always `skill://<recordKey>`, the prompt name is `<recordKey>`, and the `get_skill` tool takes `<recordKey>` as its `name`. The optional `name` field only changes how the skill is displayed. Unknown keys are ignored.

### Annotated example

This is the runnable pack shipped in this repo at [`examples/skills-pack/directory.json`](examples/skills-pack/directory.json) — point any client at it to try the server immediately (see [MCP Client Setup](#mcp-client-setup)). The `//` comments below are illustrative only; JSON does not support comments, so copy the real file rather than this annotated view.

```json
{
  "name": "example-skills",            // pack name → MCP server name
  "version": "1.0.0",                  // pack version → MCP server version
  "summary": "A minimal example skill pack for mcp-skills-tool.",
  "skills": {
    "hello-world": {                   // record key → skill://hello-world
      "path": "hello-world/SKILL.md",  // resolved relative to directory.json
      "name": "Hello World",           // optional display name
      "description": "A tiny starter skill that greets the user and shows how a skill is structured.",
      "tags": ["example", "starter"],  // optional, searchable via search_skills
      "version": "1.0.0"               // optional per-skill version
    },
    "code-review": {
      "path": "code-review/SKILL.md",
      "name": "Code Review",
      "description": "Reviews a diff for correctness, clarity, and style before it is merged.",
      "tags": ["quality", "review"],
      "version": "1.0.0"
    }
  }
}
```

**Minimal (path-only) — still fully supported:**

```json
{
  "name": "example-skills",
  "version": "1.0.0",
  "summary": "An example skill pack",
  "skills": {
    "hello-world": {
      "path": "hello-world/SKILL.md"
    }
  }
}
```

Both forms parse identically; omitting the optional fields simply falls back to the record-key-based defaults.

---

## Tools, Resources & Prompts

### Resources

Each skill is exposed as a `skill://<recordKey>` resource (`text/markdown`). `resources/list` is **paginated** per the MCP spec: it returns a fixed-size page of resources plus an opaque `nextCursor` when more remain. Pass that `nextCursor` back on the next `resources/list` call to fetch the following page; the last page omits `nextCursor`. Small packs fit in a single page and never return a cursor, so existing clients are unaffected. An invalid or malformed cursor is rejected with an `InvalidParams` error.

The server also advertises a **resource template** (`resources/templates/list`): `skill://{name}` (`text/markdown`), so template-aware clients can construct a skill URI by name instead of enumerating `resources/list`.

### Prompts

Skills are additionally exposed as MCP **prompts** (slash-command style) for clients that consume skills that way. `prompts/list` returns one argument-less prompt per skill (`name` = the record key, `description` = the skill's description or a generic fallback). `prompts/get` with a skill's `name` fetches that skill's markdown and returns it as a single `user` message (`content: { type: "text", text: <markdown> }`). An unknown prompt name is rejected with an `InvalidParams` error; a content-fetch failure returns a generic `Failed to load skill content for "<name>"` error.

### Tools

| Tool | Arguments | Description |
|------|-----------|-------------|
| `list_skills` | _(none)_ | Lists the pack summary and every skill (name, description, tags). Very large packs are capped and end with `... and N more; use search_skills to filter`. |
| `search_skills` | `query: string` (required), `tags?: string[]` | Case-insensitive substring search of `query` against each skill's record key, `name`, `description`, and `tags`. Returns only matching skills, formatted like `list_skills`; when `tags` is supplied, matches are further restricted to skills carrying at least one of those tags. A query with no matches returns a plain `No skills match "<query>"` message (not an error). |
| `get_skill` | `name: string` (required) | Returns the markdown content of the named skill. |

---

## Local Usage

### Running via npx / Node.js
Ensure you have Node.js 20+ installed (an `.nvmrc` / `.node-version` pinned to `20` is provided — run `nvm use` to match). To start the MCP server locally reading a local `directory.json`:

```bash
# Clone the repository
cd mcp-skills-tool
npm install
npm run build

# Run the server via stdio
node dist/index.js --config /path/to/your/skills-repo/directory.json
```

Or run it directly using a remote `directory.json` configuration on GitHub:

```bash
node dist/index.js --config https://raw.githubusercontent.com/igmarin/rails-agent-skills/main/directory.json
```

**Try the bundled example pack.** This repo ships a small, runnable pack at [`examples/skills-pack/`](examples/skills-pack) (see the [Schema Reference](#directoryjson-schema-reference)). After `npm run build`, point the CLI at it:

```bash
node dist/index.js --config examples/skills-pack/directory.json
```

The server prints `MCP Server "example-skills" (v1.0.0) started on stdio transport.` to stderr and then waits for a client on stdio. Use this same `directory.json` in the client configs below to confirm your setup end to end.

### Running via Docker
You can run this server as a container in environments like Smithery or a local Docker setup. The image is hardened: it runs as the unprivileged `node` user (never root) and ships a `HEALTHCHECK` that verifies the entrypoint is runnable.

**Pull the published image** (multi-arch: `linux/amd64` + `linux/arm64`) from GitHub Container Registry:

```bash
# Run the published image (mounting the local skills directory)
docker run -i --rm \
  -v /absolute/path/to/skills-repo:/skills \
  ghcr.io/igmarin/mcp-skills-tool --config /skills/directory.json
```

Images are published to `ghcr.io/igmarin/mcp-skills-tool` on every version tag (`v*`); use `:latest` or pin a version tag (e.g. `:1.0.0`).

**Or build the image locally:**

```bash
# Build the image
docker build -t igmarin/mcp-skills-tool .

# Run the container (mounting the local skills directory)
docker run -i --rm \
  -v /absolute/path/to/skills-repo:/skills \
  igmarin/mcp-skills-tool --config /skills/directory.json
```

### Caching

Skill content is cached in-memory, keyed by skill path, so repeated `resources/read` and `get_skill` calls for the same skill do not re-fetch it. This matters most for remote (`http(s)://`) packs, where each read would otherwise be a network round-trip.

- Entries stay fresh for a configurable TTL (default **300 seconds**). While an entry is fresh it is served straight from memory with no I/O.
- For remote packs, after the TTL expires the fetcher **revalidates cheaply**: it remembers each skill's `ETag` (falling back to `Last-Modified`) and re-requests with `If-None-Match` / `If-Modified-Since`. A `304 Not Modified` reuses the stored body instead of re-downloading it.
- Errors are never cached — a failed fetch is retried on the next read.

| Flag | Description |
|------|-------------|
| `--cache-ttl <seconds>` | Cache TTL in seconds (default `300`). |
| `--no-cache` | Disable caching entirely; every read fetches fresh. |

```bash
# Longer TTL (10 minutes)
node dist/index.js --config /path/to/directory.json --cache-ttl 600

# Disable caching (always fetch fresh)
node dist/index.js --config /path/to/directory.json --no-cache
```

---

## Registry / Smithery

The server ships two manifests at the repository root so MCP registries can index and launch it:

- [`server.json`](server.json) — the [official MCP registry](https://registry.modelcontextprotocol.io) descriptor, following the versioned [`server.schema.json`](https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json). It declares the reverse-DNS name `io.github.igmarin/mcp-skills-tool`, the npm package launch (`@igmarin/mcp-skills-tool`, stdio transport), and the required `--config <path|url>` package argument. The matching `mcpName` in [`package.json`](package.json) lets the registry verify npm ownership.
- [`smithery.yaml`](smithery.yaml) — the [Smithery](https://smithery.ai) stdio launch descriptor. Its `configSchema` exposes the `config` path/URL (required) plus optional `cacheTtl` / `noCache`, and its `commandFunction` maps those to an `npx -y @igmarin/mcp-skills-tool --config …` invocation.

> **Registry link — coming soon.** Once the server is published to the MCP registry / listed on Smithery, the registry entry URL will be linked here. Submission is a manual, one-time step (`mcp-publisher publish` for the MCP registry; Smithery indexes `smithery.yaml` from the GitHub repo).

---

## MCP Client Setup

`mcp-skills-tool` runs as a local **stdio** MCP server, so any MCP-capable client launches it by spawning a command. There are two invocations to choose from:

- **Published (recommended):** `npx -y @igmarin/mcp-skills-tool --config <path-or-url>` — no clone or build; npm fetches the package on first run.
- **Local dev:** `node /absolute/path/to/mcp-skills-tool/dist/index.js --config <path-or-url>` — after `npm install && npm run build` in a clone.

`<path-or-url>` is either an absolute path to a local `directory.json` or an `http(s)://` URL. The snippets below point at the bundled example pack so you can verify the connection right away — swap in your own pack once it works:

```
/absolute/path/to/mcp-skills-tool/examples/skills-pack/directory.json
```

> **Use absolute paths in client configs.** Editors launch the server with an unpredictable working directory, so a relative `--config` path may fail to resolve (`Config file not found or unreadable` — see [Troubleshooting](#troubleshooting)).

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`), add an entry under `mcpServers`, then restart Claude Desktop:

```json
{
  "mcpServers": {
    "skills": {
      "command": "npx",
      "args": [
        "-y",
        "@igmarin/mcp-skills-tool",
        "--config",
        "/absolute/path/to/mcp-skills-tool/examples/skills-pack/directory.json"
      ]
    }
  }
}
```

Local-dev variant (using a built `dist/`):

```json
{
  "mcpServers": {
    "skills": {
      "command": "node",
      "args": [
        "/absolute/path/to/mcp-skills-tool/dist/index.js",
        "--config",
        "/absolute/path/to/mcp-skills-tool/examples/skills-pack/directory.json"
      ]
    }
  }
}
```

### Cursor

Create `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` for all projects), then restart Cursor. Cursor uses the same `mcpServers` shape as Claude Desktop, and `--config` accepts a local path or a remote URL:

```json
{
  "mcpServers": {
    "skills": {
      "command": "npx",
      "args": [
        "-y",
        "@igmarin/mcp-skills-tool",
        "--config",
        "https://raw.githubusercontent.com/igmarin/rails-agent-skills/main/directory.json"
      ]
    }
  }
}
```

### VS Code (GitHub Copilot)

Create `.vscode/mcp.json` in your workspace (or nest the same block under a top-level `mcp` key in user `settings.json`). VS Code uses a top-level `servers` object and requires an explicit `"type": "stdio"`:

```json
{
  "servers": {
    "skills": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@igmarin/mcp-skills-tool",
        "--config",
        "/absolute/path/to/mcp-skills-tool/examples/skills-pack/directory.json"
      ]
    }
  }
}
```

### Windsurf

Edit `~/.codeium/windsurf/mcp_config.json` (Windows: `%USERPROFILE%\.codeium\windsurf\mcp_config.json`), then fully quit and reopen Windsurf. Windsurf uses the `mcpServers` shape:

```json
{
  "mcpServers": {
    "skills": {
      "command": "npx",
      "args": [
        "-y",
        "@igmarin/mcp-skills-tool",
        "--config",
        "/absolute/path/to/mcp-skills-tool/examples/skills-pack/directory.json"
      ]
    }
  }
}
```

### Passing extra flags

Any CLI flag goes in `args` after `--config`. For example, to raise the cache TTL (or use `--no-cache`):

```json
"args": [
  "-y",
  "@igmarin/mcp-skills-tool",
  "--config",
  "/absolute/path/to/directory.json",
  "--cache-ttl",
  "600"
]
```

After editing a client's config, restart the client so it relaunches the server. Once connected, ask the agent to run `list_skills` (or open the `skill://hello-world` resource) to confirm the pack loaded.

---

## Troubleshooting

Expected startup failures print a concise `Error: <message>` line to **stderr** and exit with code `1` (unexpected internal errors keep a full stack trace instead). Skill-read failures surface at request time. The table maps the message you'll see to its cause and fix.

| Message | Cause | Fix |
|---------|-------|-----|
| `Config file not found or unreadable: <abs-path>` | The local `--config` path is wrong or unreadable. The path is shown resolved to **absolute** — check it matches what you expect. | Confirm the file exists (`ls <path>`). In client configs use an absolute path, since the launcher's working directory is unpredictable. |
| `Config file is not valid JSON: <abs-path>` | The local `directory.json` has a JSON syntax error (trailing comma, missing quote, a comment). | Validate it, e.g. `node -e "JSON.parse(require('fs').readFileSync('<path>','utf8'))"`. JSON has no comments. |
| `Config at <url> is not valid JSON.` | The remote config URL returned a non-JSON body (often an HTML error or login page). | Point `--config` at the **raw** JSON (e.g. a `raw.githubusercontent.com` URL), not a repo web page. |
| `Could not reach config URL: <url>` | The remote config URL could not be fetched (DNS, offline, TLS). | Check the URL and your network, e.g. `curl -I <url>`. |
| `Failed to fetch config from <url>: <status> <text>` | The server responded, but not with `2xx` (e.g. `404`, `403`). | Fix the URL/permissions; a private repo's raw URL must be public or served from an authenticated mirror. |
| `Invalid directory.json config:` followed by `- <field>: <issue>` lines | The JSON parsed but failed schema validation — e.g. a missing top-level `name`/`version`/`summary`, a `skills` value that isn't an object, or a skill missing its `path`. | Fix the listed fields against the [Schema Reference](#directoryjson-schema-reference); each line names the offending path. |
| `Invalid --cache-ttl value: <value> ...` | `--cache-ttl` got a non-numeric or negative value. | Pass a non-negative number of seconds, e.g. `--cache-ttl 600`. |
| `Skill path escapes the skills directory: <path>` (at read time) | A local skill `path` resolves outside the config's directory (via `../` or an absolute path); skill content is confined to that directory. | Make every skill `path` relative and inside the pack directory, as in the example pack. |
| `Skill URL escapes the config scope: <url>` (at read time) | For a remote pack, a skill `path` resolves outside the config URL's origin + directory prefix. | Keep skill files under the same directory as the remote `directory.json`. |
| `Unsupported skill URL scheme: <scheme>` (at read time) | A remote skill `path` resolved to a non-HTTP(S) URL. | Use `http(s)` skill paths for remote packs. |
| `Failed to fetch skill content from <url>: <text>` (at read time) | A remote skill file returned a non-OK response. | Verify the skill file exists at the expected URL and is publicly reachable. |

Not seeing the server in your client at all? Confirm the `command`/`args` are correct and absolute, restart the client after editing its config, and check the client's MCP logs — the line `MCP Server "<name>" (v<version>) started on stdio transport.` is printed to stderr when a pack loads successfully.

---

## Developer / Testing Guide

This project was built using **Test-Driven Development (TDD)** using **Vitest**.

### Running Tests
To execute the unit test suites:

```bash
npm test
```

To run tests in watch mode:

```bash
npm run test:watch
```

### Debugging with MCP Inspector

The official [`@modelcontextprotocol/inspector`](https://github.com/modelcontextprotocol/inspector) provides an interactive browser UI for exercising resources, tools, and prompts while developing this server. For the Inspector's own docs, see the [MCP debugging guide](https://modelcontextprotocol.io/docs/tools/inspector).

#### stdio transport

1. Build the project (`npm run build` — the `inspect` script runs the compiled `dist/index.js`).
2. Start the Inspector against the bundled example pack:

   ```bash
   npm run inspect
   ```

   Or point it at any other pack directly:

   ```bash
   npx @modelcontextprotocol/inspector node dist/index.js --config /path/to/directory.json
   ```

3. The Inspector launches a local web UI (default `http://localhost:6274`) and spawns the stdio server for you.

Once connected:

- Click **Resources** → **List Resources** to see `skill://hello-world`, `skill://code-review`, etc. Select one and **Read Resource** to view its markdown.
- Click **Tools** → **List Tools**, then run:
  - `list_skills` (no arguments)
  - `get_skill` with `{"name": "hello-world"}`
  - `search_skills` with `{"query": "review"}` or `{"query": "example", "tags": ["starter"]}`
- Click **Prompts** → **List Prompts**, then run a prompt such as `hello-world` to see the skill returned as a single user message.

#### HTTP / Streamable HTTP transport

To inspect a Cloudflare Worker (or any runtime hosting `handleMcpRequest` from `src/worker.ts`) over Streamable HTTP:

1. Start the Worker and note the MCP endpoint URL (for example `http://localhost:8787/mcp`).
2. In the Inspector UI choose **Transport type: Streamable HTTP**, enter the endpoint URL, and click **Connect**. The Inspector manages the `mcp-session-id` handshake automatically for HTTP transports.
3. You can also use the Inspector's CLI mode against a deployed endpoint:

   ```bash
   npx @modelcontextprotocol/inspector --cli https://example.com/mcp --transport http --method tools/list
   ```

> The `inspect` script uses the built `dist/index.js`; run `npm run build` first. For a source-only loop use `npm run inspect:dev` (launches via `tsx src/index.ts`).

---

## Versioning & Changelog

Release notes live in [CHANGELOG.md](CHANGELOG.md). This project follows [Semantic Versioning](https://semver.org/); the changelog header defines the public API covered by the version contract.

Releases are automated: pushing a `vX.Y.Z` tag triggers the [`release.yml`](.github/workflows/release.yml) workflow, which runs the full quality gate, builds, and publishes to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements). See the [release process in CONTRIBUTING.md](CONTRIBUTING.md#releases--versioning) for the maintainer flow and the required `NPM_TOKEN` secret.

---

## Integration with Cloudflare Workers & Hono

This package includes a helper (`handleMcpRequest` in `dist/worker.js`) to host your MCP server over the modern web-standard **Streamable HTTP** transport on serverless platforms like Cloudflare Workers or Pages Functions running Hono.

A single endpoint handles the whole session lifecycle: `POST` an `initialize` request to open a session (the response carries an `mcp-session-id` header), then send subsequent `POST`/`GET` requests — and a final `DELETE` to tear down — with that same `mcp-session-id` header. CORS headers (including exposing `mcp-session-id`) are added to every response, so browser-based clients work out of the box.

### Example Router Configuration

In your Cloudflare Worker or Hono router, mount `handleMcpRequest` on one route that accepts `GET`, `POST`, `DELETE`, and `OPTIONS`:

```typescript
import { Hono } from 'hono';
import { handleMcpRequest, createMcpServer } from '@igmarin/mcp-skills-tool';

const app = new Hono();

app.all('/mcp', async (c) => {
  // Build a fresh MCP server per session.
  const creator = async () => {
    // 1. Fetch or load your directory.json configuration
    const directoryJson = {
      name: "example-skills",
      version: "1.0.0",
      summary: "An example skill pack",
      skills: {
        "example-skill": {
          path: "skills/example-skill/SKILL.md"
        }
      }
    };

    // 2. Fetch/resolve skill contents (e.g. from GitHub raw content or local files)
    const fetchSkillContent = async (skillPath: string) => {
      // Example: fetch from GitHub:
      const res = await fetch(`https://raw.githubusercontent.com/username/repo/main/${skillPath}`);
      return res.text();
    };

    return createMcpServer(directoryJson, fetchSkillContent);
  };

  // Handles GET/POST/DELETE (and OPTIONS preflight) on the single MCP endpoint.
  return handleMcpRequest(c.req.raw, creator);
});

export default app;
```

> Sessions are tracked in an in-memory `Map` scoped to a single Worker isolate. That is fine for short-lived connections served by one instance; for production scaling, route each session to a Cloudflare Durable Object (or equivalent stateful backend).

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, the type-check / format / lint / test workflow, and pull-request expectations. By participating, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

To report a vulnerability, follow the process in [SECURITY.md](SECURITY.md) — please do not open a public issue for security reports.

---

## License

This project is licensed under the [MIT License](LICENSE).
