import { afterEach, describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createMcpServer, RESOURCE_PAGE_SIZE, LIST_SKILLS_MAX_ENTRIES } from "./mcp-server.js";
import type { DirectoryConfig } from "./parser.js";

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

/**
 * Builds a config with `count` path-only skills keyed `skill-000`, `skill-001`,
 * … so pagination and truncation can be exercised against a pack larger than a
 * single page. Zero-padding keeps the record keys in a stable sorted order.
 */
function makeLargeConfig(count: number): DirectoryConfig {
  const skills: DirectoryConfig["skills"] = {};
  for (let i = 0; i < count; i++) {
    const key = `skill-${String(i).padStart(3, "0")}`;
    skills[key] = { path: `skills/${key}/SKILL.md` };
  }
  return {
    name: "large-skills",
    version: "1.0.0",
    summary: "A large skill pack",
    skills,
  };
}

// Track the live client/server for the current test so afterEach can tear them
// down, keeping each test isolated on its own transport pair.
let activeClient: Client | undefined;
let activeServer: Server | undefined;

/**
 * Wires a real MCP Client to a Server built from the given config (defaulting to
 * {@link mockConfig}) over a linked in-memory transport pair, so tests exercise
 * the actual JSON-RPC request/response flow instead of poking at private
 * handler internals.
 */
async function connectClient(
  fetchSkillContent: (path: string) => Promise<string>,
  config: DirectoryConfig = mockConfig,
): Promise<Client> {
  const server = createMcpServer(config, fetchSkillContent);
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
    expect(result.tools).toHaveLength(3);
    const names = result.tools.map((tool) => tool.name);
    expect(names).toContain("list_skills");
    expect(names).toContain("search_skills");
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

  it("should list every skill in list_skills for a small pack (no truncation)", async () => {
    const client = await connectClient(async () => "");

    const result = await client.callTool({ name: "list_skills", arguments: {} });
    const text = firstText(result) ?? "";

    // Small packs look exactly as before: no truncation footer.
    expect(text).not.toContain("more; use search_skills");
  });

  it("should cap and flag truncation in list_skills for a large pack", async () => {
    const total = LIST_SKILLS_MAX_ENTRIES + 7;
    const client = await connectClient(async () => "", makeLargeConfig(total));

    const result = await client.callTool({ name: "list_skills", arguments: {} });
    const text = firstText(result) ?? "";

    // Only the first LIST_SKILLS_MAX_ENTRIES lines are rendered.
    const skillLines = text.split("\n").filter((line) => line.startsWith("- "));
    expect(skillLines).toHaveLength(LIST_SKILLS_MAX_ENTRIES);
    // The remainder is disclosed and points at search_skills.
    expect(text).toContain(`... and ${total - LIST_SKILLS_MAX_ENTRIES} more; use search_skills`);
  });

  it("should match skills by record key / metadata name via search_skills", async () => {
    const client = await connectClient(async () => "");

    const result = await client.callTool({
      name: "search_skills",
      arguments: { query: "code review" },
    });
    const text = firstText(result) ?? "";

    expect(text).toContain('Skills matching "code review"');
    expect(text).toContain("Code Review");
    // Non-matching skills are excluded.
    expect(text).not.toContain("hello-world");
  });

  it("should match skills by tag via search_skills", async () => {
    const client = await connectClient(async () => "");

    const result = await client.callTool({
      name: "search_skills",
      arguments: { query: "quality" },
    });
    const text = firstText(result) ?? "";

    expect(text).toContain("Code Review");
    expect(text).not.toContain("hello-world");
  });

  it("should match skills by keyword in the description via search_skills", async () => {
    const client = await connectClient(async () => "");

    const result = await client.callTool({
      name: "search_skills",
      arguments: { query: "correctness" },
    });
    const text = firstText(result) ?? "";

    expect(text).toContain("Code Review");
    expect(text).not.toContain("hello-world");
  });

  it("should narrow search_skills results by the optional tags argument", async () => {
    const client = await connectClient(async () => "");

    // Query matches both skills' record keys via "skill"? No — use a query that
    // matches broadly, then constrain by a tag only "code-review" carries.
    const matching = await client.callTool({
      name: "search_skills",
      arguments: { query: "review", tags: ["quality"] },
    });
    expect(firstText(matching) ?? "").toContain("Code Review");

    // A tag no skill carries filters everything out.
    const none = await client.callTool({
      name: "search_skills",
      arguments: { query: "review", tags: ["nonexistent"] },
    });
    expect(firstText(none) ?? "").toContain("No skills match");

    // A query that matches a tagless skill is still excluded when tags are
    // required (hello-world has no tags), exercising the no-tags branch.
    const tagless = await client.callTool({
      name: "search_skills",
      arguments: { query: "hello", tags: ["quality"] },
    });
    expect(firstText(tagless) ?? "").toContain("No skills match");
  });

  it("should return a no-match message from search_skills when nothing matches", async () => {
    const client = await connectClient(async () => "");

    const result = await client.callTool({
      name: "search_skills",
      arguments: { query: "zzz-nothing-here" },
    });
    const text = firstText(result) ?? "";

    expect(result.isError).toBeFalsy();
    expect(text).toContain('No skills match "zzz-nothing-here"');
  });

  it("should reject invalid arguments for the search_skills tool", async () => {
    const client = await connectClient(async () => "");

    await expect(client.callTool({ name: "search_skills", arguments: {} })).rejects.toThrow(
      "Invalid arguments",
    );
  });

  it("should paginate resources/list with an opaque nextCursor", async () => {
    const total = RESOURCE_PAGE_SIZE + 10;
    const client = await connectClient(async () => "", makeLargeConfig(total));

    // First page: exactly PAGE_SIZE resources and a cursor for the rest.
    const first = await client.listResources();
    expect(first.resources).toHaveLength(RESOURCE_PAGE_SIZE);
    expect(first.nextCursor).toBeTypeOf("string");

    // Second page: the remaining resources and no further cursor.
    const second = await client.listResources({ cursor: first.nextCursor });
    expect(second.resources).toHaveLength(total - RESOURCE_PAGE_SIZE);
    expect(second.nextCursor).toBeUndefined();

    // The union covers every skill with no duplicates.
    const uris = [...first.resources, ...second.resources].map((resource) => resource.uri);
    expect(new Set(uris).size).toBe(total);
  });

  it("should return no nextCursor for a small pack (backward compatible)", async () => {
    const client = await connectClient(async () => "");

    const result = await client.listResources();
    expect(result.resources).toHaveLength(2);
    expect(result.nextCursor).toBeUndefined();
  });

  it("should reject an invalid resources/list cursor as invalid params", async () => {
    const client = await connectClient(async () => "", makeLargeConfig(RESOURCE_PAGE_SIZE + 5));

    // Garbage that is not valid base64 at all.
    await expect(client.listResources({ cursor: "not-a-valid-cursor!!!" })).rejects.toThrow(
      "Invalid pagination cursor",
    );

    // Valid base64 that decodes to a non-numeric string.
    await expect(client.listResources({ cursor: btoa("not-a-number") })).rejects.toThrow(
      "Invalid pagination cursor",
    );

    // Valid base64 that decodes to an out-of-range index.
    await expect(client.listResources({ cursor: btoa("99999") })).rejects.toThrow(
      "Invalid pagination cursor",
    );
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
