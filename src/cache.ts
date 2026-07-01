import { SkillFetcher } from "./skill-source.js";

/**
 * Options for {@link createCachingFetcher}.
 *
 * @property ttlMs - How long a cached entry stays fresh, in milliseconds.
 *   Defaults to {@link DEFAULT_CACHE_TTL_MS}. A value `<= 0` disables caching
 *   entirely (every call is delegated straight to the inner fetcher).
 * @property now - Clock used to stamp and expire entries. Defaults to
 *   `Date.now`; inject a fake clock in tests to simulate TTL expiry.
 */
export interface SkillCacheOptions {
  ttlMs?: number;
  now?: () => number;
}

/** Default time-to-live for a cached skill body: 5 minutes. */
export const DEFAULT_CACHE_TTL_MS = 300_000;

interface CacheEntry {
  value: string;
  /** Absolute timestamp (per the injected clock) after which the entry is stale. */
  expiresAt: number;
}

/**
 * Wraps a {@link SkillFetcher} with a per-path, in-memory TTL cache.
 *
 * On each call the cache is keyed by the skill path:
 * - If a fresh (non-expired) entry exists, its value is returned WITHOUT
 *   invoking `inner` (cache hit).
 * - Otherwise `inner` is awaited, the result is stored with
 *   `expiresAt = now() + ttlMs`, and returned (cache miss).
 *
 * Rejections are never cached: if `inner` throws, the error propagates and no
 * entry is stored, so the next call retries `inner`.
 *
 * When `ttlMs <= 0`, caching is disabled and the `inner` fetcher is returned
 * unchanged.
 *
 * @param inner - The fetcher to memoize (e.g. a local or remote skill fetcher)
 * @param options - Cache tuning; see {@link SkillCacheOptions}
 */
export function createCachingFetcher(
  inner: SkillFetcher,
  options: SkillCacheOptions = {},
): SkillFetcher {
  const ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = options.now ?? Date.now;

  // A non-positive TTL means "do not cache": hand back the inner fetcher so
  // every read goes straight through.
  if (ttlMs <= 0) {
    return inner;
  }

  const cache = new Map<string, CacheEntry>();
  return async (skillPath) => {
    const cached = cache.get(skillPath);
    if (cached && cached.expiresAt > now()) {
      return cached.value;
    }
    const value = await inner(skillPath);
    cache.set(skillPath, { value, expiresAt: now() + ttlMs });
    return value;
  };
}
