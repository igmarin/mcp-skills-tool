import { z } from 'zod';

export const SkillSchema = z.object({
  path: z.string()
});

export const TileConfigSchema = z.object({
  name: z.string(),
  version: z.string(),
  summary: z.string(),
  skills: z.record(z.string(), SkillSchema)
});

export type TileConfig = z.infer<typeof TileConfigSchema>;

export function parseTileConfig(json: unknown): TileConfig {
  return TileConfigSchema.parse(json);
}
