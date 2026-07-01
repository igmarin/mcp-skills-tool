import { describe, it, expect, vi } from "vitest";
import * as path from "path";
import { createLocalSkillFetcher, createRemoteSkillFetcher } from "./skill-source.js";

describe("createLocalSkillFetcher", () => {
  const configDir = "/repo/skills-pack";

  it("reads a skill inside the config directory", async () => {
    const readFile = vi.fn(async () => "# content");
    const fetchSkill = createLocalSkillFetcher(configDir, readFile);

    const out = await fetchSkill("skills/hello/SKILL.md");

    expect(out).toBe("# content");
    expect(readFile).toHaveBeenCalledWith(path.resolve(configDir, "skills/hello/SKILL.md"));
  });

  it("rejects ../ path traversal escaping the config directory", async () => {
    const readFile = vi.fn(async () => "secret");
    const fetchSkill = createLocalSkillFetcher(configDir, readFile);

    await expect(fetchSkill("../../etc/passwd")).rejects.toThrow(/escapes the skills directory/);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("rejects absolute paths outside the config directory", async () => {
    const readFile = vi.fn(async () => "secret");
    const fetchSkill = createLocalSkillFetcher(configDir, readFile);

    await expect(fetchSkill("/etc/passwd")).rejects.toThrow(/escapes the skills directory/);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("rejects null bytes in the path", async () => {
    const readFile = vi.fn(async () => "");
    const fetchSkill = createLocalSkillFetcher(configDir, readFile);

    await expect(fetchSkill("skills/foo\0.md")).rejects.toThrow(/null bytes/);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("rejects an empty path", async () => {
    const readFile = vi.fn(async () => "");
    const fetchSkill = createLocalSkillFetcher(configDir, readFile);

    await expect(fetchSkill("")).rejects.toThrow(/non-empty/);
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe("createRemoteSkillFetcher", () => {
  const configUrl = "https://raw.githubusercontent.com/user/repo/main/directory.json";

  const response = (init: Partial<Response>): typeof fetch =>
    vi.fn(async () => init as unknown as Response) as unknown as typeof fetch;

  it("fetches a same-origin skill under the config directory", async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          statusText: "OK",
          text: async () => "# remote",
        }) as unknown as Response,
    ) as unknown as typeof fetch;
    const fetchSkill = createRemoteSkillFetcher(configUrl, fetchImpl);

    const out = await fetchSkill("skills/hello/SKILL.md");

    expect(out).toBe("# remote");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/user/repo/main/skills/hello/SKILL.md",
    );
  });

  it("rejects an off-origin skill URL (SSRF)", async () => {
    const fetchImpl = response({ ok: true });
    const fetchSkill = createRemoteSkillFetcher(configUrl, fetchImpl);

    await expect(fetchSkill("https://evil.example.com/x")).rejects.toThrow(
      /escapes the config scope/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a path escaping the config directory prefix", async () => {
    const fetchImpl = response({ ok: true });
    const fetchSkill = createRemoteSkillFetcher(configUrl, fetchImpl);

    await expect(fetchSkill("../../../../secret.md")).rejects.toThrow(/escapes the config scope/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects percent-encoded traversal (%2e%2e) escaping the prefix", async () => {
    const fetchImpl = response({ ok: true });
    const fetchSkill = createRemoteSkillFetcher(configUrl, fetchImpl);

    await expect(fetchSkill("%2e%2e/%2e%2e/%2e%2e/%2e%2e/secret.md")).rejects.toThrow(
      /escapes the config scope/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects literal ../ traversal to a same-origin sibling path", async () => {
    // Exact scenario raised in review: base .../repo/main/ + ../../etc/passwd.
    // The URL parser normalizes this to /etc/passwd, which fails the prefix check.
    const fetchImpl = response({ ok: true });
    const fetchSkill = createRemoteSkillFetcher(
      "https://example.com/repo/main/directory.json",
      fetchImpl,
    );

    await expect(fetchSkill("../../etc/passwd")).rejects.toThrow(/escapes the config scope/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects non-HTTP(S) schemes (file:)", async () => {
    const fetchImpl = response({ ok: true });
    const fetchSkill = createRemoteSkillFetcher(configUrl, fetchImpl);

    await expect(fetchSkill("file:///etc/passwd")).rejects.toThrow(/Unsupported skill URL scheme/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws when the remote responds non-OK", async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: false,
          status: 404,
          statusText: "Not Found",
          text: async () => "",
        }) as unknown as Response,
    ) as unknown as typeof fetch;
    const fetchSkill = createRemoteSkillFetcher(configUrl, fetchImpl);

    await expect(fetchSkill("skills/missing.md")).rejects.toThrow(/Failed to fetch skill content/);
  });
});
