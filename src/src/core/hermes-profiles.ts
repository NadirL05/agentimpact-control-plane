import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const HermesProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  capabilities: z.array(z.string()),
  limits: z.record(z.boolean()),
});

const HermesProfilesRegistrySchema = z.object({
  profiles: z.array(HermesProfileSchema),
});

export type HermesProfile = z.infer<typeof HermesProfileSchema>;

export function getHermesProfiles(): HermesProfile[] {
  const registryPath = join(__dirname, '..', 'registries', 'hermes-profiles.json');
  const raw = readFileSync(registryPath, 'utf-8');
  const data = JSON.parse(raw);
  const parsed = HermesProfilesRegistrySchema.parse(data);
  return parsed.profiles;
}
