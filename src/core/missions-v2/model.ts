import { createHash } from 'node:crypto';
import { z } from 'zod';

export const states = ['queued','planning','ready','waiting_dependencies','blocked','running',
  'reviewing','awaiting_nadir_approval','completed','retry_wait','failed_permanent',
  'cancel_requested','cancelling','cancelled','rejected'] as const;
export type State = typeof states[number];
export class MissionError extends Error {
  constructor(public code: string, public status: 400 | 403 | 404 | 409 | 503 = 409) { super(code); }
}
export const projectSchema = z.string().regex(/^[A-Z][A-Z0-9_-]{0,63}$/);
export const admissionSchema = z.object({
  project: projectSchema,
  objective: z.string().trim().min(3).max(8000),
  title: z.string().trim().min(3).max(200),
  source_type: z.enum(['command','slack','child']),
  source_id: z.string().min(1).max(200),
  parent_mission_id: z.string().uuid().optional(),
}).strict();
export type Admission = z.infer<typeof admissionSchema>;
export const planSchema = z.object({
  acceptance_criteria: z.array(z.string().min(1).max(1000)).min(1).max(30),
  steps: z.array(z.object({ title: z.string().min(1).max(200),
    allowed_paths: z.array(z.string().max(300)).max(100) }).strict()).min(1).max(50),
  risks: z.array(z.string().max(1000)).max(30),
  completion_criteria: z.array(z.string().min(1).max(1000)).min(1).max(30),
  dependencies: z.array(z.object({ mission_id: z.string().uuid(),
    type: z.enum(['artifact','commit','human_merge']), reference: z.string().max(200).optional(),
  }).strict().refine(d => d.type !== 'commit' || /^[0-9a-f]{40}$/.test(d.reference ?? ''))).max(50),
}).strict();
export type Plan = z.infer<typeof planSchema>;
export function digest(value: unknown): string {
  function canonical(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonical);
    if (v !== null && typeof v === 'object') return Object.fromEntries(
      Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)]));
    return v;
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function enabled(env = process.env): boolean { return env.AGENTIMPACT_V2_ENABLED === '1'; }
export function projects(env = process.env): Set<string> {
  return new Set((env.AGENTIMPACT_V2_PROJECTS ?? '').split(',').filter(x => projectSchema.safeParse(x).success));
}
export function assertV2(row: { orchestration_version: number } | undefined): void {
  if (!row) throw new MissionError('mission_not_found', 404);
  if (row.orchestration_version !== 2) throw new MissionError('wrong_orchestration_version');
}
// Execution, cancellation and retry lifecycles are reserved for V2-F, even though
// their durable vocabulary is already defined. No route can start a worker here.
const foundationTransitions: Partial<Record<State, State[]>> = {
  queued: ['planning','blocked'], planning: ['blocked'],
  blocked: ['planning'], ready: ['blocked','planning'],
  waiting_dependencies: ['blocked','planning'],
};
export function assertTransition(from: State, to: State): void {
  if (!foundationTransitions[from]?.includes(to)) throw new MissionError('invalid_transition');
}
