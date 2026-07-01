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

  const expectedSkillUrl = "https://raw.githubusercontent.com/user/repo/main/skills/hello/SKILL.md";

  it("revalidates with If-None-Match and returns the cached body on 304", async () => {
    let call = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers({ ETag: '"abc123"' }),
          text: async () => "# first body",
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 304,
        statusText: "Not Modified",
        headers: new Headers(),
        text: async () => "",
      } as unknown as Response;
    });
    const fetchSkill = createRemoteSkillFetcher(configUrl, fetchMock as unknown as typeof fetch);

    const first = await fetchSkill("skills/hello/SKILL.md");
    const second = await fetchSkill("skills/hello/SKILL.md");

    expect(first).toBe("# first body");
    expect(second).toBe("# first body");
    // First request carried no conditional header.
    expect(fetchMock.mock.calls[0]).toEqual([expectedSkillUrl]);
    // Second request revalidated with the stored ETag and reused the cached body.
    expect(fetchMock.mock.calls[1]).toEqual([
      expectedSkillUrl,
      { headers: { "If-None-Match": '"abc123"' } },
    ]);
  });

  it("falls back to If-Modified-Since when only Last-Modified is present", async () => {
    const lastModified = "Wed, 21 Oct 2015 07:28:00 GMT";
    let call = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers({ "Last-Modified": lastModified }),
          text: async () => "# body v1",
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 304,
        statusText: "Not Modified",
        headers: new Headers(),
        text: async () => "",
      } as unknown as Response;
    });
    const fetchSkill = createRemoteSkillFetcher(configUrl, fetchMock as unknown as typeof fetch);

    expect(await fetchSkill("skills/hello/SKILL.md")).toBe("# body v1");
    expect(await fetchSkill("skills/hello/SKILL.md")).toBe("# body v1");
    expect(fetchMock.mock.calls[1]).toEqual([
      expectedSkillUrl,
      { headers: { "If-Modified-Since": lastModified } },
    ]);
  });

  it("updates the cached body and validator on a fresh 200 response", async () => {
    let call = 0;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      call += 1;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({ ETag: `"v${call}"` }),
        text: async () => `# body v${call}`,
      } as unknown as Response;
    });
    const fetchSkill = createRemoteSkillFetcher(configUrl, fetchMock as unknown as typeof fetch);

    expect(await fetchSkill("skills/hello/SKILL.md")).toBe("# body v1");
    // The server returns a new 200 instead of a 304, so the body is refreshed.
    expect(await fetchSkill("skills/hello/SKILL.md")).toBe("# body v2");
    expect(fetchMock.mock.calls[1]).toEqual([
      expectedSkillUrl,
      { headers: { "If-None-Match": '"v1"' } },
    ]);
    // A third read revalidates against the freshly stored validator.
    await fetchSkill("skills/hello/SKILL.md");
    expect(fetchMock.mock.calls[2]).toEqual([
      expectedSkillUrl,
      { headers: { "If-None-Match": '"v2"' } },
    ]);
  });

  it("treats a 304 without a stored validator as a fetch failure", async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: false,
          status: 304,
          statusText: "Not Modified",
          headers: new Headers(),
          text: async () => "",
        }) as unknown as Response,
    );
    const fetchSkill = createRemoteSkillFetcher(configUrl, fetchMock as unknown as typeof fetch);

    await expect(fetchSkill("skills/hello/SKILL.md")).rejects.toThrow(
      /Failed to fetch skill content/,
    );
  });
});
