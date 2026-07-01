import { describe, it, expect, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  loadConfig,
  reportFatalError,
  shutdown,
  installSignalHandlers,
  runCli,
  RunCliDeps,
  CliError,
} from "./cli.js";

const validConfig = {
  name: "test-skills",
  version: "1.0.0",
  summary: "A test skill pack",
  skills: {
    "hello-world": { path: "skills/hello-world/SKILL.md" },
  },
};

function jsonResponse(
  body: unknown,
  init?: { ok?: boolean; status?: number; statusText?: string },
) {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    statusText: init?.statusText ?? "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("loadConfig", () => {
  it("loads and validates a local config, returning a working fetcher", async () => {
    const files = new Map<string, string>();
    const result = await loadConfig("/skills/directory.json", {
      log: () => {},
      readFile: async (p) => {
        if (p.endsWith("directory.json")) {
          return JSON.stringify(validConfig);
        }
        files.set(p, "loaded");
        return "# skill content";
      },
    });

    expect(result.config.name).toBe("test-skills");
    const content = await result.fetchSkillContent("skills/hello-world/SKILL.md");
    expect(content).toBe("# skill content");
  });

  it("confines the local fetcher to the config directory (rejects traversal)", async () => {
    const result = await loadConfig("/skills/directory.json", {
      log: () => {},
      readFile: async () => JSON.stringify(validConfig),
    });

    await expect(result.fetchSkillContent("../secret.md")).rejects.toThrow(
      "escapes the skills directory",
    );
  });

  it("uses real filesystem defaults when no readFile is injected (production path)", async () => {
    // Regression guard: in production `loadConfig` is called with no `deps`, so
    // both the config read and the skill fetcher must fall back to the real
    // fs-based defaults instead of receiving `undefined`.
    const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "mcp-cli-test-"));
    try {
      await fsp.writeFile(nodePath.join(dir, "directory.json"), JSON.stringify(validConfig));
      await fsp.mkdir(nodePath.join(dir, "skills", "hello-world"), { recursive: true });
      await fsp.writeFile(
        nodePath.join(dir, "skills", "hello-world", "SKILL.md"),
        "# real skill content",
      );

      const result = await loadConfig(nodePath.join(dir, "directory.json"), { log: () => {} });
      const content = await result.fetchSkillContent("skills/hello-world/SKILL.md");
      expect(content).toBe("# real skill content");
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("raises a CliError (no stack) when the local config file is unreadable", async () => {
    const promise = loadConfig("/nope/directory.json", {
      log: () => {},
      readFile: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });

    await expect(promise).rejects.toBeInstanceOf(CliError);
    await expect(promise).rejects.toThrow("Config file not found or unreadable");
  });

  it("raises a CliError when the local config is not valid JSON", async () => {
    const promise = loadConfig("/skills/directory.json", {
      log: () => {},
      readFile: async () => "{ not json ",
    });

    await expect(promise).rejects.toBeInstanceOf(CliError);
    await expect(promise).rejects.toThrow("not valid JSON");
  });

  it("raises a CliError listing schema issues for an invalid config shape", async () => {
    const promise = loadConfig("/skills/directory.json", {
      log: () => {},
      readFile: async () => JSON.stringify({ name: "x" }),
    });

    await expect(promise).rejects.toBeInstanceOf(CliError);
    await expect(promise).rejects.toThrow("Invalid directory.json config");
  });

  it("loads a remote config and confines the remote fetcher to the config scope", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("directory.json")) {
        return jsonResponse(validConfig);
      }
      return jsonResponse("# remote content");
    }) as unknown as typeof fetch;

    const result = await loadConfig("https://example.com/skills/directory.json", {
      log: () => {},
      fetchImpl,
    });

    expect(result.config.name).toBe("test-skills");
    await expect(result.fetchSkillContent("../secret.md")).rejects.toThrow(
      "escapes the config scope",
    );
  });

  it("raises a CliError when the remote config responds non-OK", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({}, { ok: false, status: 404, statusText: "Not Found" }),
    ) as unknown as typeof fetch;

    const promise = loadConfig("https://example.com/skills/directory.json", {
      log: () => {},
      fetchImpl,
    });

    await expect(promise).rejects.toBeInstanceOf(CliError);
    await expect(promise).rejects.toThrow("404 Not Found");
  });

  it("raises a CliError when the remote config URL is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const promise = loadConfig("https://example.com/skills/directory.json", {
      log: () => {},
      fetchImpl,
    });

    await expect(promise).rejects.toBeInstanceOf(CliError);
    await expect(promise).rejects.toThrow("Could not reach config URL");
  });

  it("raises a CliError when the remote config body is not valid JSON", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => {
        throw new Error("Unexpected token");
      },
    })) as unknown as typeof fetch;

    const promise = loadConfig("https://example.com/skills/directory.json", {
      log: () => {},
      fetchImpl,
    });

    await expect(promise).rejects.toBeInstanceOf(CliError);
    await expect(promise).rejects.toThrow("is not valid JSON");
  });
});

describe("reportFatalError", () => {
  it("prints a CliError concisely without a stack trace and returns exit code 1", () => {
    const lines: string[] = [];
    const code = reportFatalError(new CliError("Config file not found: /x"), (m) => lines.push(m));

    expect(code).toBe(1);
    expect(lines).toEqual(["Error: Config file not found: /x"]);
    expect(lines.join("\n")).not.toContain("at ");
  });

  it("prints the full stack for unexpected errors and returns exit code 1", () => {
    const lines: string[] = [];
    const code = reportFatalError(new Error("boom"), (m) => lines.push(m));

    expect(code).toBe(1);
    expect(lines[0]).toBe("Fatal error running MCP Server:");
    expect(lines.join("\n")).toContain("boom");
  });

  it("handles non-Error thrown values", () => {
    const lines: string[] = [];
    const code = reportFatalError("plain string failure", (m) => lines.push(m));

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("plain string failure");
  });
});

describe("shutdown", () => {
  it("closes the server and exits with code 0", async () => {
    const close = vi.fn(async () => {});
    const exit = vi.fn();

    await shutdown({ close }, "SIGINT", { exit, log: () => {} });

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("still exits 0 when closing the server fails", async () => {
    const exit = vi.fn();
    const logs: string[] = [];

    await shutdown(
      {
        close: async () => {
          throw new Error("close failed");
        },
      },
      "SIGTERM",
      { exit, log: (m) => logs.push(m) },
    );

    expect(exit).toHaveBeenCalledWith(0);
    expect(logs.join("\n")).toContain("close failed");
  });
});

describe("installSignalHandlers", () => {
  it("registers SIGINT and SIGTERM handlers that trigger a graceful shutdown", async () => {
    const handlers = new Map<string, () => void>();
    const close = vi.fn(async () => {});
    const exit = vi.fn();

    installSignalHandlers(
      { close },
      {
        register: (signal, handler) => handlers.set(signal, handler),
        exit,
        log: () => {},
      },
    );

    expect([...handlers.keys()]).toEqual(["SIGINT", "SIGTERM"]);

    handlers.get("SIGTERM")!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("runCli", () => {
  const argvFor = (config: string) => ["node", "mcp-skills-tool", "--config", config];

  it("wires config → server → transport → signals for a local --config (all deps injected)", async () => {
    const fetchSkillContent = vi.fn(async () => "# content");
    const loadConfigImpl = vi.fn(async () => ({ config: validConfig, fetchSkillContent }));
    const connect = vi.fn(async (_transport: unknown) => {});
    const close = vi.fn(async () => {});
    const server = { connect, close };
    const createServer = vi.fn((_config: unknown, _fetch: unknown) => server);
    const transport = { id: "fake-transport" };
    const createTransport = vi.fn(() => transport);
    const installSignals = vi.fn();
    const wrapFetcher = vi.fn((inner: (p: string) => Promise<string>) => inner);
    const logs: string[] = [];

    await runCli({
      argv: argvFor("/skills/directory.json"),
      loadConfigImpl: loadConfigImpl as unknown as typeof loadConfig,
      createServer: createServer as unknown as RunCliDeps["createServer"],
      createTransport: createTransport as unknown as RunCliDeps["createTransport"],
      installSignals: installSignals as unknown as RunCliDeps["installSignals"],
      wrapFetcher: wrapFetcher as unknown as RunCliDeps["wrapFetcher"],
      log: (m) => logs.push(m),
    });

    expect(loadConfigImpl).toHaveBeenCalledWith("/skills/directory.json");
    // Caching is on by default: the loaded fetcher is passed through wrapFetcher
    // (identity here) with no explicit TTL override.
    expect(wrapFetcher).toHaveBeenCalledWith(fetchSkillContent, undefined);
    expect(createServer).toHaveBeenCalledWith(validConfig, fetchSkillContent);
    expect(connect).toHaveBeenCalledWith(transport);
    expect(installSignals).toHaveBeenCalledWith(server);
    expect(logs).toEqual(['MCP Server "test-skills" (v1.0.0) started on stdio transport.']);
  });

  it("falls back to the real loadConfig and a real stdio transport for a local config", async () => {
    const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "mcp-runcli-test-"));
    try {
      await fsp.writeFile(nodePath.join(dir, "directory.json"), JSON.stringify(validConfig));
      await fsp.mkdir(nodePath.join(dir, "skills", "hello-world"), { recursive: true });
      await fsp.writeFile(
        nodePath.join(dir, "skills", "hello-world", "SKILL.md"),
        "# real skill content",
      );

      const connect = vi.fn(async (_transport: unknown) => {});
      const close = vi.fn(async () => {});
      const server = { connect, close };
      const createServer = vi.fn((_config: unknown, _fetch: unknown) => server);
      const installSignals = vi.fn();

      // loadConfigImpl and createTransport are left to their real defaults so
      // the production wiring (real loadConfig + real StdioServerTransport) is
      // exercised. createServer/installSignals stay mocked to avoid a real
      // server ever binding to stdin.
      await runCli({
        argv: argvFor(nodePath.join(dir, "directory.json")),
        createServer: createServer as unknown as RunCliDeps["createServer"],
        installSignals: installSignals as unknown as RunCliDeps["installSignals"],
        log: () => {},
      });

      expect(createServer).toHaveBeenCalledTimes(1);
      const [passedConfig, passedFetcher] = createServer.mock.calls[0]!;
      expect((passedConfig as { name: string }).name).toBe("test-skills");

      // The default createTransport built and passed a real StdioServerTransport.
      expect(connect).toHaveBeenCalledTimes(1);
      const [passedTransport] = connect.mock.calls[0]!;
      expect(passedTransport).toBeInstanceOf(StdioServerTransport);

      // The real fetcher from loadConfig resolves skill content from the temp dir.
      const content = await (passedFetcher as (p: string) => Promise<string>)(
        "skills/hello-world/SKILL.md",
      );
      expect(content).toBe("# real skill content");
      expect(installSignals).toHaveBeenCalledWith(server);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("defaults to console.error logging and installSignalHandlers when not injected", async () => {
    const server = { connect: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    const sigBefore = {
      SIGINT: process.listeners("SIGINT"),
      SIGTERM: process.listeners("SIGTERM"),
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runCli({
        argv: argvFor("/skills/directory.json"),
        loadConfigImpl: (async () => ({
          config: validConfig,
          fetchSkillContent: async () => "# c",
        })) as unknown as typeof loadConfig,
        createServer: (() => server) as unknown as RunCliDeps["createServer"],
        createTransport: (() => ({ id: "fake" })) as unknown as RunCliDeps["createTransport"],
      });

      // Default installSignalHandlers registered one-shot SIGINT/SIGTERM handlers.
      const newSigint = process.listeners("SIGINT").filter((l) => !sigBefore.SIGINT.includes(l));
      const newSigterm = process.listeners("SIGTERM").filter((l) => !sigBefore.SIGTERM.includes(l));
      expect(newSigint.length).toBeGreaterThanOrEqual(1);
      expect(newSigterm.length).toBeGreaterThanOrEqual(1);

      // Default logger wrote the startup line to stderr (console.error).
      expect(errorSpy).toHaveBeenCalledWith(
        'MCP Server "test-skills" (v1.0.0) started on stdio transport.',
      );
    } finally {
      errorSpy.mockRestore();
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        for (const listener of process.listeners(sig)) {
          if (!sigBefore[sig].includes(listener)) {
            process.removeListener(sig, listener as (...args: unknown[]) => void);
          }
        }
      }
    }
  });

  it("propagates a CliError from loadConfig (rejects) so the shim can map the exit code", async () => {
    const promise = runCli({
      argv: argvFor("/skills/directory.json"),
      loadConfigImpl: (async () => {
        throw new CliError("Config file not found or unreadable: /skills/directory.json");
      }) as unknown as typeof loadConfig,
      createServer: (() => ({
        connect: vi.fn(),
        close: vi.fn(),
      })) as unknown as RunCliDeps["createServer"],
      createTransport: (() => ({})) as unknown as RunCliDeps["createTransport"],
      installSignals: (() => {}) as unknown as RunCliDeps["installSignals"],
      log: () => {},
    });

    await expect(promise).rejects.toBeInstanceOf(CliError);
    await expect(promise).rejects.toThrow("Config file not found or unreadable");
  });

  it("caches skill content by default (inner fetcher hit only once for two reads)", async () => {
    let calls = 0;
    const fetchSkillContent = vi.fn(async () => `body${++calls}`);
    const loadConfigImpl = vi.fn(async () => ({ config: validConfig, fetchSkillContent }));
    let captured: ((p: string) => Promise<string>) | undefined;
    const createServer = vi.fn((_config: unknown, fetcher: (p: string) => Promise<string>) => {
      captured = fetcher;
      return { connect: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    });

    await runCli({
      argv: argvFor("/skills/directory.json"),
      loadConfigImpl: loadConfigImpl as unknown as typeof loadConfig,
      createServer: createServer as unknown as RunCliDeps["createServer"],
      createTransport: (() => ({ id: "t" })) as unknown as RunCliDeps["createTransport"],
      installSignals: (() => {}) as unknown as RunCliDeps["installSignals"],
      log: () => {},
    });

    expect(captured).toBeDefined();
    const first = await captured!("skills/x.md");
    const second = await captured!("skills/x.md");
    expect(first).toBe("body1");
    expect(second).toBe("body1");
    expect(fetchSkillContent).toHaveBeenCalledTimes(1);
  });

  it("skips caching when --no-cache is passed (inner fetcher called on every read)", async () => {
    let calls = 0;
    const fetchSkillContent = vi.fn(async () => `body${++calls}`);
    const loadConfigImpl = vi.fn(async () => ({ config: validConfig, fetchSkillContent }));
    const wrapFetcher = vi.fn();
    let captured: ((p: string) => Promise<string>) | undefined;
    const createServer = vi.fn((_config: unknown, fetcher: (p: string) => Promise<string>) => {
      captured = fetcher;
      return { connect: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    });

    await runCli({
      argv: [...argvFor("/skills/directory.json"), "--no-cache"],
      loadConfigImpl: loadConfigImpl as unknown as typeof loadConfig,
      wrapFetcher: wrapFetcher as unknown as RunCliDeps["wrapFetcher"],
      createServer: createServer as unknown as RunCliDeps["createServer"],
      createTransport: (() => ({ id: "t" })) as unknown as RunCliDeps["createTransport"],
      installSignals: (() => {}) as unknown as RunCliDeps["installSignals"],
      log: () => {},
    });

    // The wrapper is never invoked and the raw fetcher is passed straight through.
    expect(wrapFetcher).not.toHaveBeenCalled();
    expect(captured).toBe(fetchSkillContent);
    await captured!("skills/x.md");
    await captured!("skills/x.md");
    expect(fetchSkillContent).toHaveBeenCalledTimes(2);
  });

  it("converts --cache-ttl seconds into a millisecond TTL for the cache wrapper", async () => {
    const fetchSkillContent = vi.fn(async () => "body");
    const loadConfigImpl = vi.fn(async () => ({ config: validConfig, fetchSkillContent }));
    const wrapFetcher = vi.fn((inner: (p: string) => Promise<string>) => inner);
    const createServer = vi.fn(() => ({
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    }));

    await runCli({
      argv: [...argvFor("/skills/directory.json"), "--cache-ttl", "60"],
      loadConfigImpl: loadConfigImpl as unknown as typeof loadConfig,
      wrapFetcher: wrapFetcher as unknown as RunCliDeps["wrapFetcher"],
      createServer: createServer as unknown as RunCliDeps["createServer"],
      createTransport: (() => ({ id: "t" })) as unknown as RunCliDeps["createTransport"],
      installSignals: (() => {}) as unknown as RunCliDeps["installSignals"],
      log: () => {},
    });

    expect(wrapFetcher).toHaveBeenCalledWith(fetchSkillContent, { ttlMs: 60000 });
  });

  it("rejects an invalid --cache-ttl (non-numeric or negative) with a CliError", async () => {
    const run = (ttlArgs: string[]) =>
      runCli({
        argv: [...argvFor("/skills/directory.json"), ...ttlArgs],
        loadConfigImpl: (async () => ({
          config: validConfig,
          fetchSkillContent: async () => "body",
        })) as unknown as typeof loadConfig,
        createServer: (() => ({
          connect: vi.fn(),
          close: vi.fn(),
        })) as unknown as RunCliDeps["createServer"],
        createTransport: (() => ({})) as unknown as RunCliDeps["createTransport"],
        installSignals: (() => {}) as unknown as RunCliDeps["installSignals"],
        log: () => {},
      });

    await expect(run(["--cache-ttl", "abc"])).rejects.toBeInstanceOf(CliError);
    await expect(run(["--cache-ttl", "abc"])).rejects.toThrow("Invalid --cache-ttl");
    await expect(run(["--cache-ttl=-5"])).rejects.toThrow("Invalid --cache-ttl");
  });
});
