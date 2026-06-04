import { z } from 'zod';

export const SkillSchema = z.object({
  path: z.string()
});

export const DirectoryConfigSchema = z.object({
  name: z.string(),
  version: z.string(),
  summary: z.string(),
  skills: z.record(z.string(), SkillSchema)
});

export type DirectoryConfig = z.infer<typeof DirectoryConfigSchema>;

export function parseDirectoryConfig(json: unknown): DirectoryConfig {
  return DirectoryConfigSchema.parse(json);
}
