import * as fs from "fs/promises";
import * as path from "path";

/**
 * Resolves a skill's declared (relative) path to its markdown content.
 */
export type SkillFetcher = (skillPath: string) => Promise<string>;

/** Rejects obviously malformed skill path references before any resolution. */
function assertUsableSkillPath(skillPath: string): void {
  if (typeof skillPath !== "string" || skillPath.length === 0) {
    throw new Error("Skill path must be a non-empty string");
  }
  if (skillPath.includes("\0")) {
    throw new Error("Skill path must not contain null bytes");
  }
}

/**
 * Builds a fetcher that reads skill files from the local filesystem, confined to
 * `configDir`. A skill path that resolves outside that directory (via `../`
 * traversal or an absolute path) is rejected before any file is read.
 *
 * @param configDir - Directory that contains the directory.json config
 * @param readFile - Injectable file reader (defaults to fs/promises readFile, utf-8)
 */
export function createLocalSkillFetcher(
  configDir: string,
  readFile: (absolutePath: string) => Promise<string> = (p) => fs.readFile(p, "utf-8"),
): SkillFetcher {
  const root = path.resolve(configDir);
  return async (skillPath) => {
    assertUsableSkillPath(skillPath);
    const resolved = path.resolve(root, skillPath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`Skill path escapes the skills directory: ${skillPath}`);
    }
    return readFile(resolved);
  };
}

/** A previously fetched body together with its revalidation validator(s). */
interface RevalidationEntry {
  etag?: string;
  lastModified?: string;
  body: string;
}

/**
 * Builds a fetcher that loads skill files over HTTP(S), confined to the origin
 * and directory prefix of the config URL. Skill paths that resolve to a
 * different origin, escape the config's directory, or use a non-HTTP(S) scheme
 * are rejected before any request is made (mitigating SSRF / scope escape).
 *
 * The fetcher performs cheap conditional revalidation: for each path it
 * remembers the last `ETag` (or, failing that, `Last-Modified`) and body. On a
 * subsequent fetch it sends `If-None-Match` / `If-Modified-Since`, and a
 * `304 Not Modified` response returns the stored body without re-downloading
 * it. This complements the higher-level TTL cache (see `createCachingFetcher`),
 * which avoids the round-trip entirely while an entry is still fresh.
 *
 * @param configUrl - URL the directory.json config was loaded from
 * @param fetchImpl - Injectable fetch implementation (defaults to global fetch)
 */
export function createRemoteSkillFetcher(
  configUrl: string,
  fetchImpl: typeof fetch = fetch,
): SkillFetcher {
  const base = new URL(".", new URL(configUrl));
  // Per-path revalidation store: validator(s) + last body for conditional GETs.
  const revalidation = new Map<string, RevalidationEntry>();

  return async (skillPath) => {
    assertUsableSkillPath(skillPath);
    const target = new URL(skillPath, base);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error(`Unsupported skill URL scheme: ${target.protocol}`);
    }
    // `target.pathname` is already normalized by the WHATWG URL parser: both
    // literal (`../`) and percent-encoded (`%2e%2e`) dot-segments are decoded
    // and collapsed before this point, so confining by origin + directory
    // prefix is sufficient to prevent traversal. (Proven in the tests.)
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) {
      throw new Error(`Skill URL escapes the config scope: ${target.href}`);
    }

    const url = target.toString();
    const prior = revalidation.get(url);
    const conditionalHeaders: Record<string, string> = {};
    if (prior?.etag) {
      conditionalHeaders["If-None-Match"] = prior.etag;
    } else if (prior?.lastModified) {
      conditionalHeaders["If-Modified-Since"] = prior.lastModified;
    }

    const res =
      Object.keys(conditionalHeaders).length > 0
        ? await fetchImpl(url, { headers: conditionalHeaders })
        : await fetchImpl(url);

    // 304 Not Modified: the stored body is still current. Handle this before the
    // `!res.ok` branch, since a 304 is deliberately not "ok".
    if (res.status === 304 && prior) {
      return prior.body;
    }
    if (!res.ok) {
      throw new Error(`Failed to fetch skill content from ${target.href}: ${res.statusText}`);
    }

    const body = await res.text();
    const etag = res.headers?.get("ETag") ?? undefined;
    const lastModified = res.headers?.get("Last-Modified") ?? undefined;
    if (etag || lastModified) {
      revalidation.set(url, { etag, lastModified, body });
    } else {
      // No validator to revalidate against next time; drop any stale record.
      revalidation.delete(url);
    }
    return body;
  };
}
