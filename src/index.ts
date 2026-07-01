#!/usr/bin/env node
import { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp-server.js";
import { loadConfig, reportFatalError, installSignalHandlers } from "./cli.js";

const program = new Command();

program
  .name("mcp-skills-tool")
  .description("MCP Server to expose agent skills defined in directory.json")
  .version("1.0.0")
  .requiredOption("-c, --config <path>", "Path or URL to directory.json config file")
  .parse(process.argv);

const options = program.opts();

/**
 * CLI entrypoint: loads and validates the --config source, creates the MCP
 * server, connects it to the stdio transport, and installs signal handlers so
 * SIGINT/SIGTERM shut the server down cleanly.
 */
async function main() {
  const { config, fetchSkillContent } = await loadConfig(options.config);
  const server = createMcpServer(config, fetchSkillContent);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  installSignalHandlers(server);

  console.error(`MCP Server "${config.name}" (v${config.version}) started on stdio transport.`);
}

main().catch((error) => {
  process.exit(reportFatalError(error));
});
