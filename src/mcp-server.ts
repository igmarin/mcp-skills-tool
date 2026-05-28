import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { TileConfig } from "./parser.js";

export function createMcpServer(
  config: TileConfig,
  fetchSkillContent: (path: string) => Promise<string>
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
    }
  );

  // List all skills as resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: Object.entries(config.skills).map(([name, skill]) => ({
        uri: `skill://${name}`,
        name: name,
        mimeType: "text/markdown",
        description: `Agent skill: ${name}`
      }))
    };
  });

  // Read individual skill content
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    if (!uri.startsWith("skill://")) {
      throw new Error(`Invalid URI scheme: ${uri}`);
    }
    const skillName = uri.substring("skill://".length);
    const skill = config.skills[skillName];
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
    } catch (error: any) {
      throw new Error(`Failed to read skill content: ${error?.message || error}`);
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
            properties: {}
          }
        },
        {
          name: "get_skill",
          description: "Retrieve the specific instructions and markdown content for a given skill.",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "The name of the skill to retrieve (e.g., 'code-review')"
              }
            },
            required: ["name"]
          }
        }
      ]
    };
  });

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "list_skills") {
      const skillsList = Object.keys(config.skills).join("\n- ");
      return {
        content: [
          {
            type: "text",
            text: `Available skills:\n- ${skillsList}`
          }
        ]
      };
    }

    if (name === "get_skill") {
      const parsedArgs = z.object({ name: z.string() }).safeParse(args);
      if (!parsedArgs.success) {
        throw new Error("Invalid arguments. 'name' string is required.");
      }

      const skillName = parsedArgs.data.name;
      const skill = config.skills[skillName];
      if (!skill) {
        throw new Error(`Skill not found: ${skillName}`);
      }

      try {
        const content = await fetchSkillContent(skill.path);
        return {
          content: [
            {
              type: "text",
              text: content
            }
          ]
        };
      } catch (error: any) {
        throw new Error(`Failed to fetch skill content: ${error?.message || error}`);
      }
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}
