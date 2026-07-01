import * as fs from "fs/promises";
import * as path from "path";
import { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { parseDirectoryConfig, DirectoryConfig } from "./parser.js";
import { createLocalSkillFetcher, createRemoteSkillFetcher, SkillFetcher } from "./skill-source.js";
import { createCachingFetcher, SkillCacheOptions } from "./cache.js";
import { createMcpServer } from "./mcp-server.js";

/**
 * Signals an expected, user-facing failure — a bad config path, invalid JSON,
 * a schema violation, or an unreachable config URL. These are reported to the
 * user as a concise message (no stack trace), unlike unexpected internal
 * errors which stay verbose for debugging.
 */
export class CliError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CliError";
  }
}

/** Injectable dependencies for {@link loadConfig} (used to isolate tests from I/O). */
export interface LoadConfigDeps {
  /** Reads a file as UTF-8 text. Defaults to `fs/promises` `readFile`. */
  readFile?: (absolutePath: string) => Promise<string>;
  /** Fetch implementation. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Informational logger (stderr). Defaults to `console.error`. */
  log?: (message: string) => void;
}

/** Result of {@link loadConfig}: the validated config and a scope-confined fetcher. */
export interface LoadedConfig {
  config: DirectoryConfig;
  fetchSkillContent: SkillFetcher;
}

function isRemoteSource(source: string): boolean {
  return source.startsWith("http://") || source.startsWith("https://");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolves the `--config` source (local path or `http(s)` URL), loads and
 * validates the `directory.json`, and returns the parsed config together with
 * a scope-confined skill fetcher.
 *
 * Expected failures (missing/unreadable file, invalid JSON, schema violation,
 * unreachable URL, non-OK response) are wrapped in {@link CliError} with a
 * concise message. Unexpected failures propagate unchanged so their stack is
 * preserved for debugging.
 */
export async function loadConfig(
  configSource: string,
  deps: LoadConfigDeps = {},
): Promise<LoadedConfig> {
  const log = deps.log ?? ((message: string) => console.error(message));
  let configJson: unknown;
  let fetchSkillContent: SkillFetcher;

  if (isRemoteSource(configSource)) {
    log(`Loading config from URL: ${configSource}`);
    const fetchImpl = deps.fetchImpl ?? fetch;

    let response: Response;
    try {
      response = await fetchImpl(configSource);
    } catch (error) {
      throw new CliError(`Could not reach config URL: ${configSource}`, { cause: error });
    }
    if (!response.ok) {
      throw new CliError(
        `Failed to fetch config from ${configSource}: ${response.status} ${response.statusText}`,
      );
    }
    try {
      configJson = await response.json();
    } catch (error) {
      throw new CliError(`Config at ${configSource} is not valid JSON.`, { cause: error });
    }
    // Reuse the same resolved fetch (with its default) for the skill fetcher,
    // so the defaulting is explicit here rather than relying on the factory.
    fetchSkillContent = createRemoteSkillFetcher(configSource, fetchImpl);
  } else {
    const absoluteConfigPath = path.resolve(configSource);
    log(`Loading config from local path: ${absoluteConfigPath}`);
    const readFile = deps.readFile ?? ((p: string) => fs.readFile(p, "utf-8"));

    let fileContent: string;
    try {
      fileContent = await readFile(absoluteConfigPath);
    } catch (error) {
      throw new CliError(`Config file not found or unreadable: ${absoluteConfigPath}`, {
        cause: error,
      });
    }
    try {
      configJson = JSON.parse(fileContent);
    } catch (error) {
      throw new CliError(`Config file is not valid JSON: ${absoluteConfigPath}`, { cause: error });
    }
    // Reuse the same resolved reader (with its default) for the skill fetcher,
    // so the defaulting is explicit here rather than relying on the factory.
    fetchSkillContent = createLocalSkillFetcher(path.dirname(absoluteConfigPath), readFile);
  }

  try {
    const config = parseDirectoryConfig(configJson);
    return { config, fetchSkillContent };
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues
        .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("\n");
      throw new CliError(`Invalid directory.json config:\n${issues}`, { cause: error });
    }
    throw error;
  }
}

/**
 * Reports a fatal startup error and returns the process exit code (always 1).
 * A {@link CliError} is printed as a single concise line; any other error keeps
 * its full stack so unexpected failures remain debuggable.
 */
export function reportFatalError(
  error: unknown,
  log: (message: string) => void = (message: string) => console.error(message),
): number {
  if (error instanceof CliError) {
    log(`Error: ${error.message}`);
    return 1;
  }
  log("Fatal error running MCP Server:");
  log(error instanceof Error && error.stack ? error.stack : String(error));
  return 1;
}

/** A server (or transport) that can be closed during shutdown. */
export interface ClosableServer {
  close(): Promise<void>;
}

/** Injectable dependencies for signal handling (used to isolate tests from `process`). */
export interface SignalDeps {
  /** Registers a one-shot signal handler. Defaults to `process.once`. */
  register?: (signal: NodeJS.Signals, handler: () => void) => void;
  /** Exits the process. Defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Informational logger (stderr). Defaults to `console.error`. */
  log?: (message: string) => void;
}

/**
 * Closes the server (which closes its transport) and exits with code 0.
 * A stop triggered by SIGINT/SIGTERM is a successful, expected shutdown, so a
 * failure while closing is logged but does not change the exit code.
 */
export async function shutdown(
  server: ClosableServer,
  signal: string,
  deps: SignalDeps = {},
): Promise<void> {
  const log = deps.log ?? ((message: string) => console.error(message));
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  log(`Received ${signal}, shutting down MCP server...`);
  try {
    await server.close();
  } catch (error) {
    log(`Error while closing server: ${describe(error)}`);
  }
  exit(0);
}

/**
 * Registers SIGINT and SIGTERM handlers that gracefully shut the server down
 * via {@link shutdown}. Handlers are one-shot so a second signal is not queued
 * behind an in-progress shutdown.
 */
export function installSignalHandlers(server: ClosableServer, deps: SignalDeps = {}): void {
  const register =
    deps.register ??
    ((signal: NodeJS.Signals, handler: () => void) => {
      process.once(signal, handler);
    });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    register(signal, () => {
      void shutdown(server, signal, deps);
    });
  }
}

/**
 * A server that can be connected to a transport and later closed. Both
 * {@link createMcpServer}'s `Server` and test doubles satisfy this shape.
 */
export interface ConnectableServer extends ClosableServer {
  connect(transport: Transport): Promise<void>;
}

/**
 * Injectable dependencies for {@link runCli}. Every external constructor and
 * function used during bootstrap is overridable so the entrypoint can be
 * exercised without real stdio, a real server, or real signal handlers.
 */
export interface RunCliDeps {
  /** Argument vector to parse. Defaults to `process.argv`. */
  argv?: string[];
  /** Builds the MCP server from a validated config + fetcher. Defaults to {@link createMcpServer}. */
  createServer?: (config: DirectoryConfig, fetchSkillContent: SkillFetcher) => ConnectableServer;
  /** Builds the transport the server connects to. Defaults to a `StdioServerTransport`. */
  createTransport?: () => Transport;
  /** Installs signal handlers on the server. Defaults to {@link installSignalHandlers}. */
  installSignals?: (server: ConnectableServer) => void;
  /** Config loader. Defaults to {@link loadConfig}. */
  loadConfigImpl?: typeof loadConfig;
  /** Wraps the loaded fetcher with caching. Defaults to {@link createCachingFetcher}. */
  wrapFetcher?: (inner: SkillFetcher, options?: SkillCacheOptions) => SkillFetcher;
  /** Informational logger (stderr). Defaults to `console.error`. */
  log?: (message: string) => void;
}

/**
 * CLI bootstrap: parses `--config`, loads and validates the config source,
 * wraps the skill fetcher with an in-memory TTL cache (unless `--no-cache` is
 * passed), creates the MCP server, connects it to the stdio transport, installs
 * SIGINT/SIGTERM handlers for a clean shutdown, and logs the startup line to
 * stderr. Extracted from the `index.ts` shim so the wiring is unit-testable via
 * {@link RunCliDeps} without touching real stdio or a real server.
 */
export async function runCli(deps: RunCliDeps = {}): Promise<void> {
  const argv = deps.argv ?? process.argv;
  const createServer = deps.createServer ?? createMcpServer;
  const createTransport = deps.createTransport ?? (() => new StdioServerTransport());
  const installSignals = deps.installSignals ?? installSignalHandlers;
  const loadConfigImpl = deps.loadConfigImpl ?? loadConfig;
  const wrapFetcher = deps.wrapFetcher ?? createCachingFetcher;
  const log = deps.log ?? ((message: string) => console.error(message));

  const program = new Command();
  program
    .name("mcp-skills-tool")
    .description("MCP Server to expose agent skills defined in directory.json")
    .version("1.0.0")
    .requiredOption("-c, --config <path>", "Path or URL to directory.json config file")
    .option("--no-cache", "Disable in-memory skill-content caching (always fetch fresh)")
    .option("--cache-ttl <seconds>", "Skill-content cache TTL in seconds (default: 300)")
    .parse(argv);

  const options = program.opts<{ config: string; cache: boolean; cacheTtl?: string }>();

  const { config, fetchSkillContent } = await loadConfigImpl(options.config);

  let fetcher = fetchSkillContent;
  if (options.cache !== false) {
    let cacheOptions: SkillCacheOptions | undefined;
    if (options.cacheTtl !== undefined) {
      const seconds = Number(options.cacheTtl);
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new CliError(
          `Invalid --cache-ttl value: ${options.cacheTtl} (expected a non-negative number of seconds).`,
        );
      }
      cacheOptions = { ttlMs: seconds * 1000 };
    }
    fetcher = wrapFetcher(fetchSkillContent, cacheOptions);
  }

  const server = createServer(config, fetcher);

  const transport = createTransport();
  await server.connect(transport);
  installSignals(server);

  log(`MCP Server "${config.name}" (v${config.version}) started on stdio transport.`);
}
