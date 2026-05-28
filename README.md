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

This package includes a helper (`handleMcpRequest` in `dist/worker.js`) to host your MCP server over Server-Sent Events (SSE) on serverless platforms like Cloudflare Workers or Pages Functions running Hono.

### Example Router Configuration

In your Cloudflare Worker or Hono router:

```typescript
import { Hono } from 'hono';
import { handleMcpRequest, createMcpServer } from '@igmarin/mcp-skills-tool';

const app = new Hono();

app.all('/mcp/*', async (c) => {
  const creator = async () => {
    // 1. Fetch or load your tile.json configuration
    const tileJson = {
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

    return createMcpServer(tileJson, fetchSkillContent);
  };

  // Process GET (SSE connection) and POST (incoming JSON-RPC messages)
  return handleMcpRequest(c.req.raw, creator);
});

export default app;
```
