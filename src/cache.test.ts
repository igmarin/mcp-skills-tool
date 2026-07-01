import { describe, it, expect, vi } from "vitest";
import { createCachingFetcher, DEFAULT_CACHE_TTL_MS } from "./cache.js";

describe("createCachingFetcher", () => {
  it("serves a second read of the same path from cache (hit, inner called once)", async () => {
    let calls = 0;
    const inner = vi.fn(async (path: string) => `content:${path}:${++calls}`);
    const fetchSkill = createCachingFetcher(inner);

    const first = await fetchSkill("skills/a.md");
    const second = await fetchSkill("skills/a.md");

    expect(inner).toHaveBeenCalledTimes(1);
    expect(first).toBe("content:skills/a.md:1");
    expect(second).toBe(first);
  });

  it("caches different paths independently", async () => {
    const inner = vi.fn(async (path: string) => `content:${path}`);
    const fetchSkill = createCachingFetcher(inner);

    const a = await fetchSkill("skills/a.md");
    const b = await fetchSkill("skills/b.md");
    // Repeat reads are both hits now.
    await fetchSkill("skills/a.md");
    await fetchSkill("skills/b.md");

    expect(a).toBe("content:skills/a.md");
    expect(b).toBe("content:skills/b.md");
    expect(inner).toHaveBeenCalledTimes(2);
    expect(inner).toHaveBeenNthCalledWith(1, "skills/a.md");
    expect(inner).toHaveBeenNthCalledWith(2, "skills/b.md");
  });

  it("re-fetches after the TTL expires (miss on a stale entry)", async () => {
    let current = 1000;
    const now = () => current;
    let calls = 0;
    const inner = vi.fn(async () => `v${++calls}`);
    const fetchSkill = createCachingFetcher(inner, { ttlMs: 500, now });

    expect(await fetchSkill("skills/a.md")).toBe("v1"); // miss → stored, expiresAt = 1500
    current = 1400;
    expect(await fetchSkill("skills/a.md")).toBe("v1"); // still fresh → hit
    current = 1500;
    expect(await fetchSkill("skills/a.md")).toBe("v2"); // expiresAt not > now → miss
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("does not cache when ttlMs <= 0 (always calls inner)", async () => {
    let calls = 0;
    const inner = vi.fn(async () => `v${++calls}`);
    const fetchSkill = createCachingFetcher(inner, { ttlMs: 0 });

    expect(await fetchSkill("skills/a.md")).toBe("v1");
    expect(await fetchSkill("skills/a.md")).toBe("v2");
    expect(await fetchSkill("skills/a.md")).toBe("v3");
    expect(inner).toHaveBeenCalledTimes(3);
  });

  it("does not cache rejections (a thrown error is retried on the next call)", async () => {
    let calls = 0;
    const inner = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("transient failure");
      }
      return "recovered";
    });
    const fetchSkill = createCachingFetcher(inner);

    await expect(fetchSkill("skills/a.md")).rejects.toThrow("transient failure");
    expect(await fetchSkill("skills/a.md")).toBe("recovered");
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("uses the default TTL and the real clock when options are omitted", async () => {
    // No `now` injected → falls back to Date.now; two immediate reads land well
    // within the default 5-minute TTL, so the second is a hit.
    expect(DEFAULT_CACHE_TTL_MS).toBe(300_000);
    const inner = vi.fn(async () => "cached-body");
    const fetchSkill = createCachingFetcher(inner);

    await fetchSkill("skills/a.md");
    await fetchSkill("skills/a.md");

    expect(inner).toHaveBeenCalledTimes(1);
  });
});
