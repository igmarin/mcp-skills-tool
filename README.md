# MCP Skills Tool

A versatile Model Context Protocol (MCP) server that reads `tile.json` skill packs (such as those used by Tessl) and dynamically exposes those skills as MCP resources and tools to AI coding agents.

It supports running locally via **STDIO** (npm/npx or Docker) and hosting on the edge via **HTTP/SSE** (Cloudflare Workers/Pages Functions).

## Features
* **Standard-Compliant Resource Exposure**: Registers each skill defined in `tile.json` as a `skill://<name>` resource.
* **Helper Tools**: Exposes `list_skills` and `get_skill` tools for clients that prefer tool interaction over resources.
* **Dual Transport**: Supports stdio transport for local use and a custom SSE stream transport for serverless Cloudflare Workers.
* **Flexibility**: Works with both local files and remote GitHub configuration paths.

---

## Local Usage

### Running via npx / Node.js
Ensure you have Node.js 20+ installed. To start the MCP server locally reading a local `tile.json`:

```bash
# Clone the repository
cd mcp-skills-tool
npm install
npm run build

# Run the server via stdio
node dist/index.js --config /path/to/your/skills-repo/tile.json
```

Or run it directly using a remote `tile.json` configuration on GitHub:

```bash
node dist/index.js --config https://raw.githubusercontent.com/igmarin/rails-agent-skills/main/tile.json
```

### Running via Docker
You can package this server as a container to run in environments like Smithery or local Docker setups:

```bash
# Build the image
docker build -t igmarin/mcp-skills-tool .

# Run the container (mounting the local skills directory)
docker run -i --rm \
  -v /absolute/path/to/skills-repo:/skills \
  igmarin/mcp-skills-tool --config /skills/tile.json
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

## Integration with Cloudflare Workers & Hono

To host your skill subdomains (e.g., `rails-agent-skills.ismaelmarin.dev/mcp`) on your free Cloudflare Wrangler/Pages account:

### 1. DNS & Custom Domains Configuration
In your Cloudflare dashboard under your Pages project (e.g. `ismaelmarin-dev`), add the subdomains as **Custom Domains**:
* `rails-agent-skills.ismaelmarin.dev`
* `ruby-core-skills.ismaelmarin.dev`
* `hanakai-yaku.ismaelmarin.dev`
* `agnostic-planning-skills.ismaelmarin.dev`

All subdomains should point directly to your main Pages project.

### 2. Hono Router Integration
In your portfolio application router (e.g., `ismaelmarin/src/index.tsx`), import the `handleMcpRequest` helper and `createMcpServer` factory:

```typescript
import { Hono } from 'hono';
import { handleMcpRequest } from './worker.js'; // imported from @igmarin/mcp-skills-tool
import { createMcpServer } from './mcp-server.js';

const app = new Hono();

// Map subdomains to their respective GitHub repositories
const SUBDOMAIN_MAP: Record<string, { repo: string; tile: string }> = {
  "rails-agent-skills": { repo: "igmarin/rails-agent-skills", tile: "tile.json" },
  "ruby-core-skills": { repo: "igmarin/ruby-core-skills", tile: "tile.json" },
  "hanakai-yaku": { repo: "igmarin/hanakai-yaku", tile: "tile.json" },
  "agnostic-planning-skills": { repo: "igmarin/agnostic-planning-skills", tile: "tile.json" }
};

// Route MCP requests dynamically
app.all('/mcp/*', async (c) => {
  const host = c.req.header('host') || "";
  const subdomain = host.split('.')[0];
  const config = SUBDOMAIN_MAP[subdomain];

  if (!config) {
    return c.text("Subdomain not found in MCP registry", 404);
  }

  // Create the MCP server instance fetching its skills dynamically from GitHub
  const creator = async () => {
    // 1. Fetch tile.json
    const tileRes = await fetch(`https://raw.githubusercontent.com/${config.repo}/main/${config.tile}`);
    const tileJson = await tileRes.json();

    // 2. Fetch skill contents
    const fetchSkillContent = async (skillPath: string) => {
      const res = await fetch(`https://raw.githubusercontent.com/${config.repo}/main/${skillPath}`);
      return res.text();
    };

    return createMcpServer(tileJson, fetchSkillContent);
  };

  // Process GET (SSE) and POST (JSON-RPC) traffic via standard transport
  return handleMcpRequest(c.req.raw, creator);
});

// Serve main portfolio page
app.get('/', (c) => {
  // your existing portfolio logic...
});

export default app;
```

With this setup:
* When an AI client makes a `GET` request to `https://rails-agent-skills.ismaelmarin.dev/mcp`, an SSE connection is opened.
* When the client sends commands via `POST https://rails-agent-skills.ismaelmarin.dev/mcp/post?sessionId=...`, the Hono route forwards it to the active transport session.
* All skills are fetched on-demand from the raw GitHub contents, keeping the server completely stateless.
