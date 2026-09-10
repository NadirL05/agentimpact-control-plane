/**
 * Jarvis audit sink — memory + optional Postgres (012_jarvis_v1_audit.sql).
 * Never logs secrets or credential material.
 */
import type { Pool } from 'pg';

export type JarvisAuditEventType =
  | 'jarvis.request.received'
  | 'jarvis.intent.parsed'
  | 'jarvis.action.planned'
  | 'jarvis.policy.allowed'
  | 'jarvis.policy.denied'
  | 'jarvis.approval.required'
  | 'jarvis.execution.started'
  | 'jarvis.execution.completed'
  | 'jarvis.execution.failed'
  | 'jarvis.mutation.requested'
  | 'jarvis.mutation.allowed'
  | 'jarvis.mutation.denied'
  | 'jarvis.mutation.started'
  | 'jarvis.mutation.completed'
  | 'jarvis.mutation.failed'
  | 'jarvis.mutation.idempotent_replay'
  | 'jarvis.mutation.stale_fence'
  | 'jarvis.agent_start.requested'
  | 'jarvis.agent_start.policy_evaluated'
  | 'jarvis.agent_start.approval_required'
  | 'jarvis.agent_start.approved'
  | 'jarvis.agent_start.quota_checked'
  | 'jarvis.agent_start.budget_reserved'
  | 'jarvis.agent_start.lease_acquired'
  | 'jarvis.agent_start.provider_requested'
  | 'jarvis.agent_start.running'
  | 'jarvis.agent_start.completed'
  | 'jarvis.agent_start.failed'
  | 'jarvis.agent_start.stopped'
  | 'jarvis.agent_start.timeout'
  | 'jarvis.agent_start.reconciled';

export type JarvisAuditEvent = {
  request_id: string;
  event_type: JarvisAuditEventType;
  actor: string;
  organization_id?: string;
  action?: string;
  mission_id?: string;
  attempt_id?: string;
  decision?: string;
  duration_ms?: number;
  error_code?: string;
  details?: Record<string, unknown>;
  timestamp: string;
};

const SENSITIVE = /super(set)?_api_key|bearer\s+[a-z0-9._-]+|sk_(?:live|test)_[a-z0-9_-]+|password|secret/i;

function redact(value: unknown): unknown {
  if (typeof value === 'string') return SENSITIVE.test(value) ? '[REDACTED]' : value;
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) ? '[REDACTED]' : redact(v);
    }
    return out;
  }
  return value;
}

export interface JarvisAuditLog {
  append(event: Omit<JarvisAuditEvent, 'timestamp'> & { timestamp?: string }): Promise<void>;
  list(requestId: string): Promise<JarvisAuditEvent[]>;
}

export class MemoryJarvisAuditLog implements JarvisAuditLog {
  readonly events: JarvisAuditEvent[] = [];
  async append(event: Omit<JarvisAuditEvent, 'timestamp'> & { timestamp?: string }): Promise<void> {
    this.events.push({
      ...event,
      details: event.details ? redact(event.details) as Record<string, unknown> : undefined,
      timestamp: event.timestamp ?? new Date().toISOString(),
    });
  }
  async list(requestId: string): Promise<JarvisAuditEvent[]> {
    return this.events.filter((e) => e.request_id === requestId);
  }
}

export class PostgresJarvisAuditLog implements JarvisAuditLog {
  constructor(private readonly pool: Pool, private readonly memory = new MemoryJarvisAuditLog()) {}
  async append(event: Omit<JarvisAuditEvent, 'timestamp'> & { timestamp?: string }): Promise<void> {
    const full: JarvisAuditEvent = {
      ...event,
      details: event.details ? redact(event.details) as Record<string, unknown> : {},
      timestamp: event.timestamp ?? new Date().toISOString(),
    };
    await this.memory.append(full);
    try {
      await this.pool.query(
        `INSERT INTO jarvis_audit_events
          (request_id, event_type, actor, organization_id, action, mission_id, attempt_id, decision, duration_ms, error_code, details, created_at)
         VALUES ($1::uuid,$2,$3,$4,$5,$6::uuid,$7::uuid,$8,$9,$10,$11::jsonb,$12::timestamptz)`,
        [
          full.request_id, full.event_type, full.actor, full.organization_id ?? null,
          full.action ?? null, full.mission_id ?? null, full.attempt_id ?? null,
          full.decision ?? null, full.duration_ms ?? null, full.error_code ?? null,
          JSON.stringify(full.details ?? {}), full.timestamp,
        ],
      );
    } catch {
      // Table may not exist yet — memory remains authoritative for the process.
    }
  }
  async list(requestId: string): Promise<JarvisAuditEvent[]> {
    return this.memory.list(requestId);
  }
}
