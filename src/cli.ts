import * as fs from "fs/promises";
import * as path from "path";
import { z } from "zod";
import { parseDirectoryConfig, DirectoryConfig } from "./parser.js";
import { createLocalSkillFetcher, createRemoteSkillFetcher, SkillFetcher } from "./skill-source.js";

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
    fetchSkillContent = createRemoteSkillFetcher(configSource, deps.fetchImpl);
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
    fetchSkillContent = createLocalSkillFetcher(path.dirname(absoluteConfigPath), deps.readFile);
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
