import { z } from "zod";

/**
 * Zod schema for a single skill entry in directory.json.
 * Defines the shape of the object mapped under each skill name.
 *
 * Only `path` is required. The `name`, `description`, `tags`, and `version`
 * fields are optional metadata: existing path-only configs still validate, and
 * when present the metadata is surfaced in `resources/list` and `list_skills`
 * so agents can understand a skill without fetching its content. The object is
 * intentionally non-strict, so unknown keys continue to be stripped.
 */
export const SkillSchema = z.object({
  path: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  version: z.string().optional(),
});

/**
 * Zod schema for the root directory.json configuration file.
 * Validates the skill pack metadata and the skills record.
 */
export const DirectoryConfigSchema = z.object({
  name: z.string(),
  version: z.string(),
  summary: z.string(),
  skills: z.record(z.string(), SkillSchema),
});

/**
 * Inferred TypeScript type from {@link DirectoryConfigSchema}.
 * Represents a validated skill pack configuration.
 */
export type DirectoryConfig = z.infer<typeof DirectoryConfigSchema>;

/**
 * Parses and validates an unknown JSON value against the DirectoryConfig schema.
 *
 * @param json - Raw parsed JSON value (typically from directory.json)
 * @returns A strongly typed {@link DirectoryConfig} object
 * @throws If the input fails Zod validation
 */
export function parseDirectoryConfig(json: unknown): DirectoryConfig {
  return DirectoryConfigSchema.parse(json);
}
