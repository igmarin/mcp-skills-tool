import { describe, it, expect } from "vitest";
import { createMcpServer } from "./mcp-server.js";

describe("createMcpServer", () => {
  const mockConfig = {
    name: "test-skills",
    version: "1.0.0",
    summary: "A test skill pack",
    skills: {
      "hello-world": {
        path: "skills/hello-world/SKILL.md",
      },
    },
  };

  it("should instantiate the MCP server correctly", () => {
    const server = createMcpServer(mockConfig, async () => "Hello World");
    expect(server).toBeDefined();
  });

  it("should list registered skills as resources", async () => {
    const server = createMcpServer(mockConfig, async () => "Hello World");
    const listFn = (server as any)._requestHandlers.get("resources/list");

    const result = await listFn({ method: "resources/list" });
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]).toEqual({
      uri: "skill://hello-world",
      name: "hello-world",
      mimeType: "text/markdown",
      description: "Agent skill: hello-world",
    });
  });

  it("should read skill content as a resource", async () => {
    let fetchedPath = "";
    const server = createMcpServer(mockConfig, async (path) => {
      fetchedPath = path;
      return "# Hello World Skill Content";
    });

    const readFn = (server as any)._requestHandlers.get("resources/read");

    const result = await readFn({
      method: "resources/read",
      params: {
        uri: "skill://hello-world",
      },
    });

    expect(fetchedPath).toBe("skills/hello-world/SKILL.md");
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]).toEqual({
      uri: "skill://hello-world",
      mimeType: "text/markdown",
      text: "# Hello World Skill Content",
    });
  });

  it("should throw an error when reading an invalid resource URI", async () => {
    const server = createMcpServer(mockConfig, async () => "");
    const readFn = (server as any)._requestHandlers.get("resources/read");

    await expect(
      readFn({
        method: "resources/read",
        params: { uri: "invalid-scheme://hello-world" },
      }),
    ).rejects.toThrow("Invalid URI scheme");

    await expect(
      readFn({
        method: "resources/read",
        params: { uri: "skill://does-not-exist" },
      }),
    ).rejects.toThrow("Skill not found");
  });

  it("should throw an error when skill content read fails", async () => {
    const server = createMcpServer(mockConfig, async () => {
      throw new Error("File not found");
    });
    const readFn = (server as any)._requestHandlers.get("resources/read");

    await expect(
      readFn({
        method: "resources/read",
        params: { uri: "skill://hello-world" },
      }),
    ).rejects.toThrow("Failed to read skill content");
  });

  it("should list custom tools", async () => {
    const server = createMcpServer(mockConfig, async () => "");
    const listToolsFn = (server as any)._requestHandlers.get("tools/list");

    const result = await listToolsFn({ method: "tools/list" });
    expect(result.tools).toHaveLength(2);
    expect(result.tools.map((t: any) => t.name)).toContain("list_skills");
    expect(result.tools.map((t: any) => t.name)).toContain("get_skill");
  });

  it("should execute list_skills tool", async () => {
    const server = createMcpServer(mockConfig, async () => "");
    const callToolFn = (server as any)._requestHandlers.get("tools/call");

    const result = await callToolFn({
      method: "tools/call",
      params: {
        name: "list_skills",
        arguments: {},
      },
    });

    expect(result.content[0].text).toContain("hello-world");
  });

  it("should execute get_skill tool", async () => {
    const server = createMcpServer(mockConfig, async () => "Skill Content here");
    const callToolFn = (server as any)._requestHandlers.get("tools/call");

    const result = await callToolFn({
      method: "tools/call",
      params: {
        name: "get_skill",
        arguments: { name: "hello-world" },
      },
    });

    expect(result.content[0].text).toBe("Skill Content here");
  });

  it("should throw an error for invalid arguments in get_skill tool", async () => {
    const server = createMcpServer(mockConfig, async () => "");
    const callToolFn = (server as any)._requestHandlers.get("tools/call");

    await expect(
      callToolFn({
        method: "tools/call",
        params: {
          name: "get_skill",
          arguments: {},
        },
      }),
    ).rejects.toThrow("Invalid arguments");
  });

  it("should throw an error when get_skill finds unknown skill", async () => {
    const server = createMcpServer(mockConfig, async () => "");
    const callToolFn = (server as any)._requestHandlers.get("tools/call");

    await expect(
      callToolFn({
        method: "tools/call",
        params: {
          name: "get_skill",
          arguments: { name: "unknown-skill" },
        },
      }),
    ).rejects.toThrow("Skill not found");
  });

  it("should throw an error when get_skill content fetch fails", async () => {
    const server = createMcpServer(mockConfig, async () => {
      throw new Error("Network error");
    });
    const callToolFn = (server as any)._requestHandlers.get("tools/call");

    await expect(
      callToolFn({
        method: "tools/call",
        params: {
          name: "get_skill",
          arguments: { name: "hello-world" },
        },
      }),
    ).rejects.toThrow("Failed to fetch skill content");
  });

  it("should throw an error for unknown tool", async () => {
    const server = createMcpServer(mockConfig, async () => "");
    const callToolFn = (server as any)._requestHandlers.get("tools/call");

    await expect(
      callToolFn({
        method: "tools/call",
        params: {
          name: "unknown_tool",
          arguments: {},
        },
      }),
    ).rejects.toThrow("Unknown tool");
  });
});
