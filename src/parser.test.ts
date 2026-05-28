import { describe, it, expect } from 'vitest';
import { parseTileConfig } from './parser.js';

describe('parseTileConfig', () => {
  it('should parse tile.json metadata and skills list', () => {
    const mockTileJson = {
      name: "test-skills",
      version: "1.0.0",
      summary: "A test skill pack",
      skills: {
        "hello-world": {
          path: "skills/hello-world/SKILL.md"
        }
      }
    };

    const parsed = parseTileConfig(mockTileJson);
    expect(parsed.name).toBe("test-skills");
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.summary).toBe("A test skill pack");
    expect(parsed.skills["hello-world"]).toEqual({
      path: "skills/hello-world/SKILL.md"
    });
  });

  it('should throw an error if tile.json is missing required fields', () => {
    const invalidJson = {
      version: "1.0.0"
    };

    expect(() => parseTileConfig(invalidJson)).toThrow();
  });
});
