import { z } from 'zod';

/**
 * Zod schema for a single skill entry in directory.json.
 * Defines the shape of the object mapped under each skill name.
 */
export const SkillSchema = z.object({
  path: z.string()
});

/**
 * Zod schema for the root directory.json configuration file.
 * Validates the skill pack metadata and the skills record.
 */
export const DirectoryConfigSchema = z.object({
  name: z.string(),
  version: z.string(),
  summary: z.string(),
  skills: z.record(z.string(), SkillSchema)
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
