import { z } from 'zod';

export const operatorOperationSchema = z.enum([
  'agentimpact.status',
  'agentimpact.health',
  'agentimpact.missions.list',
  'agentimpact.missions.inspect',
  'agentimpact.missions.create',
  'agentimpact.missions.cancel',
  'agentimpact.missions.events',
  'agentimpact.agent.status',
  'agentimpact.agent.start',
  'agentimpact.agent.stop',
  'agentimpact.workspace.inspect',
  'agentimpact.tests.run',
  'agentimpact.tests.status',
  'agentimpact.diff.read',
  'agentimpact.approvals.list',
  'agentimpact.approvals.inspect',
  'agentimpact.approvals.approve',
  'agentimpact.publisher.prepare',
  'agentimpact.publisher.publish',
  'agentimpact.deploy.prepare',
  'agentimpact.deploy.execute',
]);
export type OperatorOperation = z.infer<typeof operatorOperationSchema>;

const uuid = z.string().uuid();
const project = z.string().regex(/^[A-Z][A-Z0-9_-]{0,63}$/);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const payloadHash = z.string().regex(/^[0-9a-f]{64}$/);
const reason = z.string().trim().min(3).max(2000);

export const operatorParametersSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('agentimpact.status'), parameters: z.object({ project: project.optional() }).strict() }),
  z.object({ operation: z.literal('agentimpact.health'), parameters: z.object({}).strict() }),
  z.object({ operation: z.literal('agentimpact.missions.list'), parameters: z.object({ project: project.optional(), limit: z.number().int().min(1).max(100).optional() }).strict() }),
  z.object({ operation: z.literal('agentimpact.missions.inspect'), parameters: z.object({ mission_id: uuid }).strict() }),
  z.object({ operation: z.literal('agentimpact.missions.create'), parameters: z.object({
    project, title: z.string().trim().min(3).max(200), objective: z.string().trim().min(3).max(8000),
    requested_worker_type: z.enum(['codex', 'cursor']), reason,
  }).strict() }),
  z.object({ operation: z.literal('agentimpact.missions.cancel'), parameters: z.object({ mission_id: uuid, reason }).strict() }),
  z.object({ operation: z.literal('agentimpact.missions.events'), parameters: z.object({ mission_id: uuid, after: z.string().regex(/^\d{1,18}$/).optional() }).strict() }),
  z.object({ operation: z.literal('agentimpact.agent.status'), parameters: z.object({ mission_id: uuid }).strict() }),
  z.object({ operation: z.literal('agentimpact.agent.start'), parameters: z.object({
    mission_id: uuid, attempt_id: uuid, requested_worker_type: z.enum(['codex', 'cursor']), reason,
    fencing_token: z.string().regex(/^[1-9]\d{0,18}$/), workspace_id: uuid,
    approval_id: uuid.optional(), budget_ceiling: z.number().int().positive().max(1_000_000),
  }).strict() }),
  z.object({ operation: z.literal('agentimpact.agent.stop'), parameters: z.object({ mission_id: uuid, attempt_id: uuid, reason }).strict() }),
  z.object({ operation: z.literal('agentimpact.workspace.inspect'), parameters: z.object({ mission_id: uuid }).strict() }),
  z.object({ operation: z.literal('agentimpact.tests.run'), parameters: z.object({ mission_id: uuid, attempt_id: uuid, test_profile: z.enum(['unit', 'integration', 'lint', 'typecheck', 'mission_validation']) }).strict() }),
  z.object({ operation: z.literal('agentimpact.tests.status'), parameters: z.object({ mission_id: uuid }).strict() }),
  z.object({ operation: z.literal('agentimpact.diff.read'), parameters: z.object({ mission_id: uuid }).strict() }),
  z.object({ operation: z.literal('agentimpact.approvals.list'), parameters: z.object({ limit: z.number().int().min(1).max(100).optional() }).strict() }),
  z.object({ operation: z.literal('agentimpact.approvals.inspect'), parameters: z.object({ action_id: uuid }).strict() }),
  z.object({ operation: z.literal('agentimpact.approvals.approve'), parameters: z.object({ action_id: uuid, payload_hash: payloadHash, decision: z.enum(['approved', 'rejected']), reason: reason.optional() }).strict() }),
  z.object({ operation: z.literal('agentimpact.publisher.prepare'), parameters: z.object({
    mission_id: uuid, attempt_id: uuid, repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    head_sha: sha, base_branch: z.enum(['main', 'master', 'staging']).default('main'),
  }).strict() }),
  z.object({ operation: z.literal('agentimpact.publisher.publish'), parameters: z.object({ action_id: uuid, payload_hash: payloadHash }).strict() }),
  z.object({ operation: z.literal('agentimpact.deploy.prepare'), parameters: z.object({
    release_id: z.string().regex(/^\d{8}T\d{6}Z-[0-9a-f]{12}$/), source_commit: sha,
    target: z.enum(['staging', 'production']), rollback_release_id: z.string().regex(/^\d{8}T\d{6}Z-[0-9a-f]{12}$/),
    publisher_action_id: uuid,
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    base_branch: z.enum(['main', 'master', 'staging']),
  }).strict() }),
  z.object({ operation: z.literal('agentimpact.deploy.execute'), parameters: z.object({ action_id: uuid, payload_hash: payloadHash }).strict() }),
]);

export const operatorRequestSchema = z.object({
  request_id: uuid,
  organization_id: z.string().trim().min(1).max(200),
  requested_at: z.string().datetime(),
  operation: operatorOperationSchema,
  parameters: z.record(z.string(), z.unknown()).default({}),
}).strict().superRefine((value, ctx) => {
  const parsed = operatorParametersSchema.safeParse({ operation: value.operation, parameters: value.parameters });
  if (!parsed.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid_operation_parameters' });
});
export type OperatorRequest = z.infer<typeof operatorRequestSchema>;

export const operatorResponseSchema = z.object({
  request_id: uuid,
  operation: operatorOperationSchema,
  ok: z.boolean(),
  status: z.enum(['completed', 'accepted', 'approval_required', 'blocked', 'failed']),
  data: z.unknown().optional(),
  error_code: z.string().max(120).optional(),
  explanation: z.string().max(1000),
}).strict();
export type OperatorResponse = z.infer<typeof operatorResponseSchema>;
