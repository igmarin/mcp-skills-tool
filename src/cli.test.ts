import { describe, it, expect, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { loadConfig, reportFatalError, shutdown, installSignalHandlers, CliError } from "./cli.js";

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
