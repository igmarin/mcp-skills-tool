import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DirectoryConfig } from "./parser.js";

/**
 * Looks up a skill by name using an own-property check, so a client-supplied
 * name such as `__proto__` or `constructor` cannot resolve to an inherited
 * object member instead of a real skill entry.
 */
function lookupSkill(
  config: DirectoryConfig,
  name: string,
): DirectoryConfig["skills"][string] | undefined {
  if (!Object.hasOwn(config.skills, name)) {
    return undefined;
  }
  return config.skills[name];
}

/**
 * Formats a single skill as one readable line for the `list_skills` tool,
 * folding in whatever optional metadata is present. Path-only skills reduce to
 * `- <recordKey>`; enriched skills add their description and tags, e.g.
 * `- <name>: <description> [tags: a, b]`. Output is deterministic (it mirrors
 * the config's insertion order and only appends metadata that exists).
 */
function formatSkillLine(recordKey: string, skill: DirectoryConfig["skills"][string]): string {
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
 * - A `skill://<name>` resource for direct content retrieval
 * - Helper tools (`list_skills`, `get_skill`) for clients that prefer tool interaction
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

  // List all skills as resources. The resource `uri` always keys off the record
  // name (`skill://<recordKey>`), while optional per-skill metadata enriches the
  // display: a `name`/`description` from the config is preferred, falling back
  // to the record key and the generic `Agent skill: <name>` label when absent.
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: Object.entries(config.skills).map(([recordKey, skill]) => ({
        uri: `skill://${recordKey}`,
        name: skill.name ?? recordKey,
        mimeType: "text/markdown",
        description: skill.description ?? `Agent skill: ${recordKey}`,
      })),
    };
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

  // List tools: exposing get_skill and list_skills as helper tools
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
      const skillLines = Object.entries(config.skills)
        .map(([recordKey, skill]) => formatSkillLine(recordKey, skill))
        .join("\n");
      const text = `${config.summary}\n\nAvailable skills:\n${skillLines}`;
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
