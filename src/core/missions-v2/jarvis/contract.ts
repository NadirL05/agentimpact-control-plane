/**
 * Jarvis V1 typed action contract — no arbitrary objects, no shell/argv.
 */
import { z } from 'zod';

export const jarvisRiskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);
export type JarvisRiskLevel = z.infer<typeof jarvisRiskLevelSchema>;

export const jarvisPolicyDecisionSchema = z.enum([
  'ALLOW',
  'DENY',
  'REQUIRE_APPROVAL',
  'BLOCKED_BY_FEATURE_FLAG',
  'CONFLICT',
  'STALE_FENCE',
  'QUOTA_EXCEEDED',
  'BUDGET_EXCEEDED',
  'CONCURRENCY_LIMIT',
  'LEASE_CONFLICT',
  'INVALID_STATE',
]);
export type JarvisPolicyDecision = z.infer<typeof jarvisPolicyDecisionSchema>;

export const jarvisTestProfileSchema = z.enum([
  'unit',
  'integration',
  'lint',
  'typecheck',
  'mission_validation',
]);
export type JarvisTestProfile = z.infer<typeof jarvisTestProfileSchema>;

/** Actions Jarvis may emit. Blocked actions exist so policy can name them explicitly. */
export const jarvisActionNameSchema = z.enum([
  // READ / AUTO
  'status.get',
  'mission.list',
  'mission.inspect',
  'mission.events',
  'workspace.list',
  'workspace.inspect',
  'terminal.read',
  'diff.read',
  'tests.status',
  'agent.status',
  'project.list',
  // CONTROLLED MUTATIONS
  'mission.create',
  'mission.cancel',
  'workspace.create',
  'workspace.delete',
  'terminal.send',
  'tests.run',
  'agent.stop',
  // BLOCKED / APPROVAL
  'agent.start',
  'agent.create',
  'publisher.push',
  'publisher.pr_create',
  'publisher.merge',
  'deploy',
  'database.migrate',
  'secret.read',
  'secret.write',
  'root.exec',
  'docker.exec',
  'generic.shell',
]);
export type JarvisActionName = z.infer<typeof jarvisActionNameSchema>;

export const SAFE_MUTATION_ACTIONS = new Set<JarvisActionName>([
  'mission.create', 'mission.cancel',
  'workspace.create', 'workspace.delete',
  'tests.run', 'agent.stop',
]);

const uuid = z.string().uuid();
const orgId = z.string().trim().min(1).max(200);
const actor = z.string().trim().min(1).max(200);
const reason = z.string().trim().min(1).max(2000);

/** Strict parameter bags — no free-form passthrough. */
export const jarvisActionParametersSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status.get'), parameters: z.object({ project: z.string().min(1).max(64).optional() }).strict() }),
  z.object({ action: z.literal('mission.list'), parameters: z.object({ project: z.string().min(1).max(64).optional() }).strict() }),
  z.object({ action: z.literal('mission.inspect'), parameters: z.object({ mission_id: uuid }).strict() }),
  z.object({ action: z.literal('mission.events'), parameters: z.object({ mission_id: uuid, after: z.string().regex(/^\d{1,18}$/).optional() }).strict() }),
  z.object({ action: z.literal('workspace.list'), parameters: z.object({ project_id: uuid.optional() }).strict() }),
  z.object({ action: z.literal('workspace.inspect'), parameters: z.object({ workspace_id: uuid }).strict() }),
  z.object({ action: z.literal('terminal.read'), parameters: z.object({ workspace_id: uuid, terminal_id: uuid }).strict() }),
  z.object({ action: z.literal('diff.read'), parameters: z.object({ mission_id: uuid.optional() }).strict() }),
  z.object({ action: z.literal('tests.status'), parameters: z.object({ mission_id: uuid.optional() }).strict() }),
  z.object({ action: z.literal('agent.status'), parameters: z.object({ mission_id: uuid.optional() }).strict() }),
  z.object({ action: z.literal('project.list'), parameters: z.object({}).strict() }),
  z.object({ action: z.literal('mission.create'), parameters: z.object({
    title: z.string().trim().min(3).max(200),
    objective: z.string().trim().min(3).max(4000),
    project: z.string().regex(/^[A-Z][A-Z0-9_-]{0,63}$/),
    requested_worker_type: z.enum(['codex', 'cursor']),
    reason: z.string().trim().min(1).max(2000),
  }).strict() }),
  z.object({ action: z.literal('mission.cancel'), parameters: z.object({
    mission_id: uuid,
    reason: z.string().trim().min(1).max(2000),
  }).strict() }),
  z.object({ action: z.literal('workspace.create'), parameters: z.object({
    mission_id: uuid,
    attempt_id: uuid,
    fencing_token: uuid,
    project_id: uuid,
    name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/),
    branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/),
  }).strict() }),
  z.object({ action: z.literal('workspace.delete'), parameters: z.object({
    workspace_id: uuid,
    mission_id: uuid,
    attempt_id: uuid,
    fencing_token: uuid,
    reason: z.string().trim().min(1).max(2000),
  }).strict() }),
  z.object({ action: z.literal('terminal.send'), parameters: z.object({
    workspace_id: uuid, terminal_id: uuid, intent: z.literal('request_stop'),
  }).strict() }),
  z.object({ action: z.literal('tests.run'), parameters: z.object({
    mission_id: uuid,
    attempt_id: uuid,
    fencing_token: uuid,
    test_profile: jarvisTestProfileSchema,
  }).strict() }),
  z.object({ action: z.literal('agent.stop'), parameters: z.object({
    mission_id: uuid,
    attempt_id: uuid,
    fencing_token: uuid,
    reason: z.string().trim().min(1).max(2000),
  }).strict() }),
  z.object({ action: z.literal('agent.start'), parameters: z.object({
    mission_id: uuid,
    attempt_id: uuid,
    requested_worker_type: z.enum(['codex', 'cursor']),
    reason: z.string().trim().min(1).max(2000),
    fencing_token: uuid.optional(),
    workspace_id: uuid.optional(),
    approval_id: uuid.optional(),
    execution_profile: z.enum(['jarvis_low_risk_noop', 'standard']).optional(),
    max_runtime_seconds: z.number().int().positive().max(3600).optional(),
    budget_class: z.enum(['test', 'standard']).optional(),
    budget_ceiling: z.number().int().positive().max(1_000_000).optional(),
    canary_prompt: z.string().trim().min(1).max(4096).optional(),
  }).strict() }),
  z.object({ action: z.literal('agent.create'), parameters: z.object({
    mission_id: uuid.optional(),
  }).strict() }),
  z.object({ action: z.literal('publisher.push'), parameters: z.object({}).strict() }),
  z.object({ action: z.literal('publisher.pr_create'), parameters: z.object({}).strict() }),
  z.object({ action: z.literal('publisher.merge'), parameters: z.object({}).strict() }),
  z.object({ action: z.literal('deploy'), parameters: z.object({ target: z.string().max(64).optional() }).strict() }),
  z.object({ action: z.literal('database.migrate'), parameters: z.object({}).strict() }),
  z.object({ action: z.literal('secret.read'), parameters: z.object({ name: z.string().max(200).optional() }).strict() }),
  z.object({ action: z.literal('secret.write'), parameters: z.object({}).strict() }),
  z.object({ action: z.literal('root.exec'), parameters: z.object({}).strict() }),
  z.object({ action: z.literal('docker.exec'), parameters: z.object({}).strict() }),
  z.object({ action: z.literal('generic.shell'), parameters: z.object({}).strict() }),
]);

export const jarvisActionSchema = z.object({
  request_id: uuid,
  actor,
  organization_id: orgId,
  timestamp: z.string().datetime(),
  action: jarvisActionNameSchema,
  parameters: z.record(z.string(), z.unknown()).default({}),
  reason,
  risk_level: jarvisRiskLevelSchema,
  mission_id: uuid.optional(),
  attempt_id: uuid.optional(),
  fencing_token: uuid.optional(),
}).strict();
export type JarvisAction = z.infer<typeof jarvisActionSchema>;

export const jarvisIntentSchema = z.object({
  request_id: uuid,
  actor,
  organization_id: orgId,
  message: z.string().trim().min(1).max(4000),
  timestamp: z.string().datetime(),
  inferred_intent: z.string().min(1).max(200),
  confidence: z.enum(['high', 'low', 'none']),
}).strict();
export type JarvisIntent = z.infer<typeof jarvisIntentSchema>;

export const jarvisApprovalRequirementSchema = z.object({
  required: z.boolean(),
  reason: z.string().max(500),
  approver_roles: z.array(z.enum(['admin', 'nadir'])).default([]),
}).strict();
export type JarvisApprovalRequirement = z.infer<typeof jarvisApprovalRequirementSchema>;

export const jarvisPolicyResultSchema = z.object({
  action: jarvisActionNameSchema,
  decision: jarvisPolicyDecisionSchema,
  reason: z.string().min(1).max(500),
  approval: jarvisApprovalRequirementSchema.optional(),
}).strict();
export type JarvisPolicyResult = z.infer<typeof jarvisPolicyResultSchema>;

export const jarvisActionResultSchema = z.object({
  action: jarvisActionNameSchema,
  decision: jarvisPolicyDecisionSchema,
  ok: z.boolean(),
  simulated: z.boolean().default(false),
  data: z.unknown().optional(),
  error_code: z.string().max(100).optional(),
  duration_ms: z.number().int().nonnegative(),
}).strict();
export type JarvisActionResult = z.infer<typeof jarvisActionResultSchema>;

export const jarvisRequestSchema = z.object({
  request_id: uuid,
  organization_id: orgId,
  message: z.string().trim().min(1).max(4000).optional(),
  /** Typed mutation/read bypass for precise contracts (no free-form shell). */
  action: jarvisActionNameSchema.optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.message && !value.action) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'message_or_action_required' });
  }
  if (value.action && value.parameters === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'parameters_required_for_typed_action' });
  }
});
export type JarvisRequest = z.infer<typeof jarvisRequestSchema>;

export const jarvisResponseSchema = z.object({
  intent: jarvisIntentSchema,
  actions: z.array(jarvisActionSchema),
  policy: z.array(jarvisPolicyResultSchema),
  results: z.array(jarvisActionResultSchema),
}).strict();
export type JarvisResponse = z.infer<typeof jarvisResponseSchema>;

export const READ_ONLY_ACTIONS = new Set<JarvisActionName>([
  'status.get', 'mission.list', 'mission.inspect', 'mission.events',
  'workspace.list', 'workspace.inspect', 'terminal.read', 'diff.read',
  'tests.status', 'agent.status', 'project.list',
]);

export const MUTATION_ACTIONS = new Set<JarvisActionName>([
  'mission.create', 'mission.cancel', 'workspace.create', 'workspace.delete',
  'terminal.send', 'tests.run', 'agent.stop',
]);

export const BLOCKED_ACTIONS = new Set<JarvisActionName>([
  'agent.start', 'agent.create', 'publisher.push', 'publisher.pr_create', 'publisher.merge',
  'deploy', 'database.migrate', 'secret.read', 'secret.write',
  'root.exec', 'docker.exec', 'generic.shell',
]);
