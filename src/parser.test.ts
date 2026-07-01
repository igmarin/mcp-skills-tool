import { describe, it, expect } from "vitest";
import { parseDirectoryConfig } from "./parser.js";

describe("parseDirectoryConfig", () => {
  it("should parse directory.json metadata and skills list", () => {
    const mockDirectoryJson = {
      name: "test-skills",
      version: "1.0.0",
      summary: "A test skill pack",
      skills: {
        "hello-world": {
          path: "skills/hello-world/SKILL.md",
        },
      },
    };

    const parsed = parseDirectoryConfig(mockDirectoryJson);
    expect(parsed.name).toBe("test-skills");
    expect(parsed.version).toBe("1.0.0");
    expect(parsed.summary).toBe("A test skill pack");
    expect(parsed.skills["hello-world"]).toEqual({
      path: "skills/hello-world/SKILL.md",
    });
  });

  it("should throw an error if directory.json is missing required fields", () => {
    const invalidJson = {
      version: "1.0.0",
    };

    expect(() => parseDirectoryConfig(invalidJson)).toThrow();
  });

  const baseMetadata = {
    name: "test-skills",
    version: "1.0.0",
    summary: "A test skill pack",
  };

  it("should parse an empty skills record to {} (an empty record is valid)", () => {
    // Documents current behavior: `z.record(z.string(), SkillSchema)` treats an
    // empty object as a valid (empty) record — a skill pack may declare no skills.
    const parsed = parseDirectoryConfig({ ...baseMetadata, skills: {} });

    expect(parsed.skills).toEqual({});
  });

  it("should parse and preserve optional per-skill metadata", () => {
    const mockDirectoryJson = {
      name: "test-skills",
      version: "1.0.0",
      summary: "A test skill pack",
      skills: {
        "code-review": {
          path: "skills/code-review/SKILL.md",
          name: "Code Review",
          description: "Reviews a diff for correctness and style.",
          tags: ["quality", "review"],
          version: "2.1.0",
        },
      },
    };

    const parsed = parseDirectoryConfig(mockDirectoryJson);
    expect(parsed.skills["code-review"]).toEqual({
      path: "skills/code-review/SKILL.md",
      name: "Code Review",
      description: "Reviews a diff for correctness and style.",
      tags: ["quality", "review"],
      version: "2.1.0",
    });
  });

  it("should leave optional metadata undefined for a path-only skill (backward compatible)", () => {
    const parsed = parseDirectoryConfig({
      name: "test-skills",
      version: "1.0.0",
      summary: "A test skill pack",
      skills: {
        "hello-world": {
          path: "skills/hello-world/SKILL.md",
        },
      },
    });

    const skill = parsed.skills["hello-world"];
    expect(skill).toEqual({ path: "skills/hello-world/SKILL.md" });
    expect(skill.name).toBeUndefined();
    expect(skill.description).toBeUndefined();
    expect(skill.tags).toBeUndefined();
    expect(skill.version).toBeUndefined();
  });

  it("should throw when a skill entry has a non-string path", () => {
    const invalidJson = {
      ...baseMetadata,
      skills: { "hello-world": { path: 123 } },
    };

    expect(() => parseDirectoryConfig(invalidJson)).toThrow();
  });

  it("should throw when a skill entry is missing its path", () => {
    const invalidJson = {
      ...baseMetadata,
      skills: { "hello-world": {} },
    };

    expect(() => parseDirectoryConfig(invalidJson)).toThrow();
  });

  it("should throw when a skill entry's tags is a string rather than an array", () => {
    const invalidJson = {
      ...baseMetadata,
      skills: { "hello-world": { path: "skills/hello-world/SKILL.md", tags: "x" } },
    };

    expect(() => parseDirectoryConfig(invalidJson)).toThrow();
  });

  it("should throw when a skill entry's tags contains a non-string element", () => {
    const invalidJson = {
      ...baseMetadata,
      skills: { "hello-world": { path: "skills/hello-world/SKILL.md", tags: [1] } },
    };

    expect(() => parseDirectoryConfig(invalidJson)).toThrow();
  });

  it("should strip unknown top-level keys (non-strict object) and parse successfully", () => {
    // Documents current behavior: a plain `z.object` is non-strict, so unknown
    // keys are stripped rather than rejected. Rejecting them would be a
    // backward-incompatible schema change and is intentionally out of scope here.
    const parsed = parseDirectoryConfig({
      ...baseMetadata,
      extra: true,
      skills: {},
    });

    expect(parsed).not.toHaveProperty("extra");
    expect(parsed).toEqual({ ...baseMetadata, skills: {} });
  });

  it("should throw when a top-level field has the wrong type", () => {
    const invalidJson = {
      ...baseMetadata,
      version: 1,
      skills: {},
    };

    expect(() => parseDirectoryConfig(invalidJson)).toThrow();
  });

  it("should throw when skills is an array rather than a record", () => {
    const invalidJson = {
      ...baseMetadata,
      skills: [],
    };

    expect(() => parseDirectoryConfig(invalidJson)).toThrow();
  });

  it("should throw when skills is a string rather than a record", () => {
    const invalidJson = {
      ...baseMetadata,
      skills: "not-a-record",
    };

    expect(() => parseDirectoryConfig(invalidJson)).toThrow();
  });
});
