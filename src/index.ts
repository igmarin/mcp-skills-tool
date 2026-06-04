#!/usr/bin/env node
import { Command } from "commander";
import * as fs from "fs/promises";
import * as path from "path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseDirectoryConfig } from "./parser.js";
import { createMcpServer } from "./mcp-server.js";

const program = new Command();

program
  .name("mcp-skills-tool")
  .description("MCP Server to expose agent skills defined in directory.json")
  .version("1.0.0")
  .requiredOption("-c, --config <path>", "Path or URL to directory.json config file")
  .parse(process.argv);

const options = program.opts();

async function main() {
  const configSource = options.config;
  const isRemote = configSource.startsWith("http://") || configSource.startsWith("https://");

  let configJson: unknown;
  let fetchSkillContent: (skillPath: string) => Promise<string>;

  if (isRemote) {
    // Remote HTTP/HTTPS configuration
    console.error(`Loading config from URL: ${configSource}`);
    const response = await fetch(configSource);
    if (!response.ok) {
      throw new Error(`Failed to fetch config from ${configSource}: ${response.statusText}`);
    }
    configJson = await response.json();

    const configUrl = new URL(configSource);
    const baseUrl = new URL(".", configUrl).toString();

    fetchSkillContent = async (skillPath: string) => {
      const targetUrl = new URL(skillPath, baseUrl).toString();
      const res = await fetch(targetUrl);
      if (!res.ok) {
        throw new Error(`Failed to fetch skill content from ${targetUrl}: ${res.statusText}`);
      }
      return res.text();
    };
  } else {
    // Local file configuration
    const absoluteConfigPath = path.resolve(configSource);
    console.error(`Loading config from local path: ${absoluteConfigPath}`);
    const configDir = path.dirname(absoluteConfigPath);
    
    const fileContent = await fs.readFile(absoluteConfigPath, "utf-8");
    configJson = JSON.parse(fileContent);

    fetchSkillContent = async (skillPath: string) => {
      const absoluteSkillPath = path.resolve(configDir, skillPath);
      return fs.readFile(absoluteSkillPath, "utf-8");
    };
  }

  const config = parseDirectoryConfig(configJson);
  const server = createMcpServer(config, fetchSkillContent);

  // Connect to stdio transport (default CLI behavior)
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`MCP Server "${config.name}" (v${config.version}) started on stdio transport.`);
}

main().catch((error) => {
  console.error("Fatal error running MCP Server:", error);
  process.exit(1);
});
