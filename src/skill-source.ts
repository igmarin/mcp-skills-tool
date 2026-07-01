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

/**
 * Builds a fetcher that loads skill files over HTTP(S), confined to the origin
 * and directory prefix of the config URL. Skill paths that resolve to a
 * different origin, escape the config's directory, or use a non-HTTP(S) scheme
 * are rejected before any request is made (mitigating SSRF / scope escape).
 *
 * @param configUrl - URL the directory.json config was loaded from
 * @param fetchImpl - Injectable fetch implementation (defaults to global fetch)
 */
export function createRemoteSkillFetcher(
  configUrl: string,
  fetchImpl: typeof fetch = fetch,
): SkillFetcher {
  const base = new URL(".", new URL(configUrl));
  return async (skillPath) => {
    assertUsableSkillPath(skillPath);
    const target = new URL(skillPath, base);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error(`Unsupported skill URL scheme: ${target.protocol}`);
    }
    if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) {
      throw new Error(`Skill URL escapes the config scope: ${target.href}`);
    }
    const res = await fetchImpl(target.toString());
    if (!res.ok) {
      throw new Error(`Failed to fetch skill content from ${target.href}: ${res.statusText}`);
    }
    return res.text();
  };
}
