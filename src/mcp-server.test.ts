import { afterEach, describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createMcpServer } from "./mcp-server.js";

const mockConfig = {
  name: "test-skills",
  version: "1.0.0",
  summary: "A test skill pack",
  skills: {
    "hello-world": {
      path: "skills/hello-world/SKILL.md",
    },
    "code-review": {
      path: "skills/code-review/SKILL.md",
      name: "Code Review",
      description: "Reviews a diff for correctness and style.",
      tags: ["quality", "review"],
      version: "2.1.0",
    },
  },
};

// Track the live client/server for the current test so afterEach can tear them
// down, keeping each test isolated on its own transport pair.
let activeClient: Client | undefined;
let activeServer: Server | undefined;

/**
 * Wires a real MCP Client to a Server built from {@link mockConfig} over a
 * linked in-memory transport pair, so tests exercise the actual JSON-RPC
 * request/response flow instead of poking at private handler internals.
 */
async function connectClient(
  fetchSkillContent: (path: string) => Promise<string>,
): Promise<Client> {
  const server = createMcpServer(mockConfig, fetchSkillContent);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  activeClient = client;
  activeServer = server;
  return client;
}

/** Extracts the first text content entry from a tool-call result. */
function firstText(result: {
  content?: Array<{ type: string; text?: string }>;
}): string | undefined {
  return result.content?.find((entry) => entry.type === "text")?.text;
}

afterEach(async () => {
  await Promise.all([activeClient?.close(), activeServer?.close()]);
  activeClient = undefined;
  activeServer = undefined;
});

describe("createMcpServer", () => {
  it("should instantiate the MCP server correctly", () => {
    const server = createMcpServer(mockConfig, async () => "Hello World");
    expect(server).toBeDefined();
  });

  it("should list registered skills as resources", async () => {
    const client = await connectClient(async () => "Hello World");

    const result = await client.listResources();
    expect(result.resources).toHaveLength(2);

    // Path-only skill falls back to the record key and the generic description.
    const helloWorld = result.resources.find((resource) => resource.uri === "skill://hello-world");
    expect(helloWorld).toMatchObject({
      uri: "skill://hello-world",
      name: "hello-world",
      mimeType: "text/markdown",
      description: "Agent skill: hello-world",
    });

    // Enriched skill surfaces its metadata `name` and `description`, while the
    // URI still keys off the record name.
    const codeReview = result.resources.find((resource) => resource.uri === "skill://code-review");
    expect(codeReview).toMatchObject({
      uri: "skill://code-review",
      name: "Code Review",
      mimeType: "text/markdown",
      description: "Reviews a diff for correctness and style.",
    });
  });

  it("should read skill content as a resource", async () => {
    let fetchedPath = "";
    const client = await connectClient(async (path) => {
      fetchedPath = path;
      return "# Hello World Skill Content";
    });

    const result = await client.readResource({ uri: "skill://hello-world" });

    expect(fetchedPath).toBe("skills/hello-world/SKILL.md");
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]).toMatchObject({
      uri: "skill://hello-world",
      mimeType: "text/markdown",
      text: "# Hello World Skill Content",
    });
  });

  it("should reject reading a resource with an invalid URI scheme", async () => {
    const client = await connectClient(async () => "");

    await expect(client.readResource({ uri: "invalid-scheme://hello-world" })).rejects.toThrow(
      "Invalid URI scheme",
    );
  });

  it("should reject reading an unknown skill", async () => {
    const client = await connectClient(async () => "");

    await expect(client.readResource({ uri: "skill://does-not-exist" })).rejects.toThrow(
      "Skill not found",
    );
  });

  it("should reject when skill content read fails", async () => {
    const client = await connectClient(async () => {
      throw new Error("File not found");
    });

    await expect(client.readResource({ uri: "skill://hello-world" })).rejects.toThrow(
      "Failed to read skill content",
    );
  });

  it("should list custom tools", async () => {
    const client = await connectClient(async () => "");

    const result = await client.listTools();
    expect(result.tools).toHaveLength(2);
    const names = result.tools.map((tool) => tool.name);
    expect(names).toContain("list_skills");
    expect(names).toContain("get_skill");
  });

  it("should execute list_skills tool", async () => {
    const client = await connectClient(async () => "");

    const result = await client.callTool({ name: "list_skills", arguments: {} });
    const text = firstText(result);

    // Header prepends the pack summary and lists every skill.
    expect(text).toContain("A test skill pack");
    expect(text).toContain("hello-world");
    // Enriched skill surfaces its name, description, and tags.
    expect(text).toContain("Code Review");
    expect(text).toContain("Reviews a diff for correctness and style.");
    expect(text).toContain("[tags: quality, review]");
  });

  it("should execute get_skill tool", async () => {
    const client = await connectClient(async () => "Skill Content here");

    const result = await client.callTool({
      name: "get_skill",
      arguments: { name: "hello-world" },
    });
    expect(firstText(result)).toBe("Skill Content here");
  });

  it("should reject invalid arguments for the get_skill tool", async () => {
    const client = await connectClient(async () => "");

    await expect(client.callTool({ name: "get_skill", arguments: {} })).rejects.toThrow(
      "Invalid arguments",
    );
  });

  it("should return an isError result when get_skill finds an unknown skill", async () => {
    const client = await connectClient(async () => "");

    const result = await client.callTool({
      name: "get_skill",
      arguments: { name: "unknown-skill" },
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Skill not found");
  });

  it("should not resolve inherited object members like __proto__ as skills", async () => {
    const client = await connectClient(async () => "");

    const result = await client.callTool({
      name: "get_skill",
      arguments: { name: "__proto__" },
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Skill not found");
  });

  it("should return an isError result when get_skill content fetch fails", async () => {
    const client = await connectClient(async () => {
      throw new Error("Network error");
    });

    const result = await client.callTool({
      name: "get_skill",
      arguments: { name: "hello-world" },
    });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("Failed to load skill");
  });

  it("should reject an unknown tool", async () => {
    const client = await connectClient(async () => "");

    await expect(client.callTool({ name: "unknown_tool", arguments: {} })).rejects.toThrow(
      "Unknown tool",
    );
  });
});
