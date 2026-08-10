import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PolicySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  rules: z.array(z.string()),
});

const PoliciesRegistrySchema = z.object({
  policies: z.array(PolicySchema),
});

export type Policy = z.infer<typeof PolicySchema>;

export function getPolicies(): Policy[] {
  const registryPath = join(__dirname, '..', 'registries', 'policies.json');
  const raw = readFileSync(registryPath, 'utf-8');
  const data = JSON.parse(raw);
  const parsed = PoliciesRegistrySchema.parse(data);
  return parsed.policies;
}
