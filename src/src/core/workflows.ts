import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WorkflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  trigger: z.array(z.string()),
  steps: z.array(z.string()),
});

const WorkflowsRegistrySchema = z.object({
  workflows: z.array(WorkflowSchema),
});

export type Workflow = z.infer<typeof WorkflowSchema>;

export function getWorkflows(): Workflow[] {
  const registryPath = join(__dirname, '..', 'registries', 'workflows.json');
  const raw = readFileSync(registryPath, 'utf-8');
  const data = JSON.parse(raw);
  const parsed = WorkflowsRegistrySchema.parse(data);
  return parsed.workflows;
}
