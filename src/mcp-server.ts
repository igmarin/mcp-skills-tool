import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  McpError,
  ErrorCode,
  type ListResourcesResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DirectoryConfig } from "./parser.js";

type Skill = DirectoryConfig["skills"][string];

/**
 * Number of resources returned per `resources/list` page. Exported so tests can
 * build a pack larger than one page without hard-coding the value.
 */
export const RESOURCE_PAGE_SIZE = 50;

/**
 * Maximum number of skill lines rendered inline by the `list_skills` tool.
 * Larger packs are truncated with a pointer to `search_skills`. Exported so
 * tests can assert the cap without hard-coding the value.
 */
export const LIST_SKILLS_MAX_ENTRIES = 50;

/**
 * Looks up a skill by name using an own-property check, so a client-supplied
 * name such as `__proto__` or `constructor` cannot resolve to an inherited
 * object member instead of a real skill entry.
 */
function lookupSkill(config: DirectoryConfig, name: string): Skill | undefined {
  if (!Object.hasOwn(config.skills, name)) {
    return undefined;
  }
  return config.skills[name];
}

/**
 * Formats a single skill as one readable line for the `list_skills` and
 * `search_skills` tools, folding in whatever optional metadata is present.
 * Path-only skills reduce to `- <recordKey>`; enriched skills add their
 * description and tags, e.g. `- <name>: <description> [tags: a, b]`. Output is
 * deterministic (it only appends metadata that exists).
 */
function formatSkillLine(recordKey: string, skill: Skill): string {
  let line = `- ${skill.name ?? recordKey}`;
  if (skill.description) {
    line += `: ${skill.description}`;
  }
  if (skill.tags && skill.tags.length > 0) {
    line += ` [tags: ${skill.tags.join(", ")}]`;
  }
  return line;
}

/**
 * Case-insensitive substring match of `query` against a skill's record key,
 * its optional metadata `name`/`description`, and each of its `tags`. Used by
 * the `search_skills` tool to filter skills without fetching their content.
 */
function skillMatchesQuery(recordKey: string, skill: Skill, query: string): boolean {
  const haystacks = [recordKey, skill.name ?? "", skill.description ?? "", ...(skill.tags ?? [])];
  return haystacks.some((value) => value.toLowerCase().includes(query));
}

/**
 * Returns true when a skill carries at least one of the requested `tags`
 * (case-insensitive). Skills without tags never match. Used to narrow
 * `search_skills` results when the optional `tags` argument is supplied.
 */
function skillHasAnyTag(skill: Skill, tags: string[]): boolean {
  if (!skill.tags || skill.tags.length === 0) {
    return false;
  }
  const skillTags = skill.tags.map((tag) => tag.toLowerCase());
  return tags.some((tag) => skillTags.includes(tag.toLowerCase()));
}

/**
 * Encodes a zero-based page offset into an opaque, web-standard base64 cursor
 * for `resources/list`. The inverse of {@link decodeCursor}. Uses `btoa` so the
 * server stays runtime-agnostic (Node and Cloudflare Workers both provide it).
 */
function encodeCursor(nextIndex: number): string {
  return btoa(String(nextIndex));
}

/**
 * Decodes an opaque `resources/list` cursor back into a page offset, validating
 * it defensively. A cursor that is not valid base64, not an integer, or out of
 * range for the current skill count is rejected as an MCP invalid-params error
 * rather than silently starting over, so clients get a clear protocol failure.
 */
function decodeCursor(cursor: string, total: number): number {
  let decoded: string;
  try {
    decoded = atob(cursor);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `Invalid pagination cursor: ${cursor}`);
  }
  const index = Number(decoded);
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    throw new McpError(ErrorCode.InvalidParams, `Invalid pagination cursor: ${cursor}`);
  }
  return index;
}

/**
 * Builds a tool result that signals failure via `isError`, following the MCP
 * guidance that tool-execution errors should be returned as results (so the
 * model can see and recover) rather than thrown as protocol errors.
 */
function toolError(message: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

/**
 * Creates and configures an MCP Server instance that exposes skills as resources and tools.
 *
 * Each skill defined in the {@link DirectoryConfig} is registered as:
 * - A `skill://<name>` resource for direct content retrieval (paginated via an
 *   opaque `nextCursor` per the MCP spec)
 * - Helper tools (`list_skills`, `search_skills`, `get_skill`) for clients that
 *   prefer tool interaction
 *
 * @param config - Validated skill pack configuration
 * @param fetchSkillContent - Async function that resolves a skill path to its markdown content
 * @returns A configured MCP {@link Server} instance ready to connect to a transport
 */
export function createMcpServer(
  config: DirectoryConfig,
  fetchSkillContent: (path: string) => Promise<string>,
): Server {
  const server = new Server(
    {
      name: config.name,
      version: config.version,
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    },
  );

  // List skills as resources with opaque cursor pagination (MCP spec). Skills
  // are sorted by record key for a deterministic order, then sliced into
  // fixed-size pages of RESOURCE_PAGE_SIZE. The resource `uri` always keys off
  // the record name (`skill://<recordKey>`), while optional per-skill metadata
  // enriches the display: a `name`/`description` from the config is preferred,
  // falling back to the record key and the generic `Agent skill: <name>` label
  // when absent. A `nextCursor` is returned only when more skills remain; an
  // invalid cursor is rejected as an invalid-params protocol error.
  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const sortedEntries = Object.entries(config.skills).sort(([a], [b]) => (a > b ? 1 : -1));
    const total = sortedEntries.length;
    const startIndex =
      request.params?.cursor !== undefined ? decodeCursor(request.params.cursor, total) : 0;
    const endIndex = Math.min(startIndex + RESOURCE_PAGE_SIZE, total);

    const resources = sortedEntries.slice(startIndex, endIndex).map(([recordKey, skill]) => ({
      uri: `skill://${recordKey}`,
      name: skill.name ?? recordKey,
      mimeType: "text/markdown",
      description: skill.description ?? `Agent skill: ${recordKey}`,
    }));

    const result: ListResourcesResult = { resources };
    if (endIndex < total) {
      result.nextCursor = encodeCursor(endIndex);
    }
    return result;
  });

  // Read individual skill content. A malformed URI or unknown skill is a protocol
  // error (invalid request); an underlying read failure is logged to stderr and
  // surfaced with a generic message so filesystem paths / internal URLs are not
  // leaked to the client.
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (!uri.startsWith("skill://")) {
      throw new Error(`Invalid URI scheme: ${uri}`);
    }
    const skillName = uri.substring("skill://".length);
    const skill = lookupSkill(config, skillName);
    if (!skill) {
      throw new Error(`Skill not found: ${skillName}`);
    }

    try {
      const content = await fetchSkillContent(skill.path);
      return {
        contents: [
          {
            uri: uri,
            mimeType: "text/markdown",
            text: content,
          },
        ],
      };
    } catch (error: unknown) {
      console.error(`Failed to read skill "${skillName}":`, error);
      throw new Error(`Failed to read skill content for "${skillName}".`);
    }
  });

  // List tools: exposing list_skills, search_skills, and get_skill as helper tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "list_skills",
          description: "List all available AI agent skills and their descriptions.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "search_skills",
          description:
            "Search available AI agent skills by a case-insensitive keyword matched against " +
            "each skill's name, description, and tags. Returns only matching skills.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "Case-insensitive substring matched against skill names, descriptions, and tags.",
              },
              tags: {
                type: "array",
                items: { type: "string" },
                description:
                  "Optional tags; when provided, only skills carrying at least one of them are returned.",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "get_skill",
          description: "Retrieve the specific instructions and markdown content for a given skill.",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "The name of the skill to retrieve (e.g., 'code-review')",
              },
            },
            required: ["name"],
          },
        },
      ],
    };
  });

  // Call tool handler. Tool-execution failures (unknown skill, fetch failure) are
  // returned as `isError` results so the model can recover; malformed calls (bad
  // arguments, unknown tool) remain protocol errors.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "list_skills") {
      // Cap the inline listing for very large packs so the model is not flooded;
      // small packs (<= LIST_SKILLS_MAX_ENTRIES) look exactly as before. When
      // truncated, point the model at search_skills to narrow things down.
      const entries = Object.entries(config.skills);
      const shown = entries.slice(0, LIST_SKILLS_MAX_ENTRIES);
      const skillLines = shown
        .map(([recordKey, skill]) => formatSkillLine(recordKey, skill))
        .join("\n");
      let text = `${config.summary}\n\nAvailable skills:\n${skillLines}`;
      const remaining = entries.length - shown.length;
      if (remaining > 0) {
        text += `\n... and ${remaining} more; use search_skills to filter.`;
      }
      return {
        content: [
          {
            type: "text",
            text,
          },
        ],
      };
    }

    if (name === "search_skills") {
      const parsedArgs = z
        .object({ query: z.string(), tags: z.array(z.string()).optional() })
        .safeParse(args);
      if (!parsedArgs.success) {
        throw new Error("Invalid arguments. 'query' string is required.");
      }

      const { query, tags } = parsedArgs.data;
      const normalizedQuery = query.toLowerCase();
      const matches = Object.entries(config.skills).filter(
        ([recordKey, skill]) =>
          skillMatchesQuery(recordKey, skill, normalizedQuery) &&
          (tags === undefined || skillHasAnyTag(skill, tags)),
      );

      if (matches.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No skills match "${query}".`,
            },
          ],
        };
      }

      const skillLines = matches
        .map(([recordKey, skill]) => formatSkillLine(recordKey, skill))
        .join("\n");
      const text = `Skills matching "${query}":\n${skillLines}`;
      return {
        content: [
          {
            type: "text",
            text,
          },
        ],
      };
    }

    if (name === "get_skill") {
      const parsedArgs = z.object({ name: z.string() }).safeParse(args);
      if (!parsedArgs.success) {
        throw new Error("Invalid arguments. 'name' string is required.");
      }

      const skillName = parsedArgs.data.name;
      const skill = lookupSkill(config, skillName);
      if (!skill) {
        return toolError(`Skill not found: ${skillName}`);
      }

      try {
        const content = await fetchSkillContent(skill.path);
        return {
          content: [
            {
              type: "text",
              text: content,
            },
          ],
        };
      } catch (error: unknown) {
        console.error(`get_skill failed for "${skillName}":`, error);
        return toolError(`Failed to load skill "${skillName}".`);
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}
