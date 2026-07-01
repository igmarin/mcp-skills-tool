# MCP Skills Tool

A versatile Model Context Protocol (MCP) server that reads `directory.json` skill packs (such as those used by Tessl) and dynamically exposes those skills as MCP resources and tools to AI coding agents.

It supports running locally via **STDIO** (npm/npx or Docker) and hosting on the edge via **HTTP/SSE** (Cloudflare Workers/Pages Functions).

## Features
* **Standard-Compliant Resource Exposure**: Registers each skill defined in `directory.json` as a `skill://<name>` resource.
* **Helper Tools**: Exposes `list_skills` and `get_skill` tools for clients that prefer tool interaction over resources.
* **Dual Transport**: Supports stdio transport for local use and a custom SSE stream transport for serverless Cloudflare Workers.
* **Flexibility**: Works with both local files and remote GitHub configuration paths.

---

## Configuration (`directory.json`)

A skill pack is described by a `directory.json` file. The top-level fields (`name`, `version`, `summary`) describe the pack, and `skills` maps a record key to a skill entry. Each skill entry requires only a `path`; the remaining per-skill fields are **optional metadata** that lets agents understand a skill without fetching its content.

| Field | Location | Required | Description |
|-------|----------|----------|-------------|
| `name` | top level | yes | Skill pack name (used as the MCP server name). |
| `version` | top level | yes | Skill pack version (used as the MCP server version). |
| `summary` | top level | yes | One-line pack summary; prepended to the `list_skills` output. |
| `skills` | top level | yes | Record of `<recordKey>` → skill entry. |
| `path` | skill entry | yes | Path to the skill's markdown, resolved relative to the config. |
| `name` | skill entry | no | Display name; used for the resource `name` (falls back to the record key). |
| `description` | skill entry | no | Human-readable description; used for the resource `description` and in `list_skills` (falls back to `Agent skill: <recordKey>`). |
| `tags` | skill entry | no | `string[]` of tags; surfaced in `list_skills`. |
| `version` | skill entry | no | Per-skill version string. |

The resource `uri` is always `skill://<recordKey>` regardless of the optional `name`. Unknown keys are ignored.

**Minimal (path-only) — still fully supported:**

```json
{
  "name": "example-skills",
  "version": "1.0.0",
  "summary": "An example skill pack",
  "skills": {
    "hello-world": {
      "path": "skills/hello-world/SKILL.md"
    }
  }
}
```

**Enriched with per-skill metadata:**

```json
{
  "name": "example-skills",
  "version": "1.0.0",
  "summary": "An example skill pack",
  "skills": {
    "code-review": {
      "path": "skills/code-review/SKILL.md",
      "name": "Code Review",
      "description": "Reviews a diff for correctness and style.",
      "tags": ["quality", "review"],
      "version": "2.1.0"
    }
  }
}
```

Both forms parse identically; omitting the optional fields simply falls back to the previous behavior.

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

### Running via Docker
You can package this server as a container to run in environments like Smithery or local Docker setups:

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

---

## Versioning & Changelog

Release notes live in [CHANGELOG.md](CHANGELOG.md). This project follows [Semantic Versioning](https://semver.org/); the changelog header defines the public API covered by the version contract.

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

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, the type-check / format / lint / test workflow, and pull-request expectations.

## Security

To report a vulnerability, follow the process in [SECURITY.md](SECURITY.md) — please do not open a public issue for security reports.

---

## License

This project is licensed under the [MIT License](LICENSE).
