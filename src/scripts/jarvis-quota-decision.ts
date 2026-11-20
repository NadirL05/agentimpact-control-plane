#!/usr/bin/env node
/**
 * Print typed Codex quota decision for canary/smoke (no provider completion).
 * Usage: node --import tsx scripts/jarvis-quota-decision.ts [codex|cursor]
 */
import { pool } from '../api/db.js';
import {
  classifyCurrentQuotaRow,
  getAgentQuotaDecision,
  CODEX_QUOTA_DISCOVERY,
  type JarvisWorkerType,
} from '../core/missions-v2/jarvis/agent-quota.js';

async function main() {
  const worker = ((process.argv[2] || 'codex').trim() === 'cursor' ? 'cursor' : 'codex') as JarvisWorkerType;
  let row = null;
  try {
    const r = await pool.query(
      `SELECT worker_type, quota_state, source, reason, observed_at, expires_at, updated_at, note
       FROM jarvis_agent_quota_state WHERE worker_type=$1`,
      [worker],
    );
    row = r.rows[0] ?? null;
  } catch {
    row = null;
  }
  const decision = getAgentQuotaDecision(row, { workerType: worker });
  const classification = classifyCurrentQuotaRow(row);
  const out = {
    ...decision,
    CURRENT_CODEX_QUOTA_CLASSIFICATION: classification,
    CODEX_QUOTA_DISCOVERY_METHOD: CODEX_QUOTA_DISCOVERY.method,
    CODEX_QUOTA_DISCOVERY_TRUST_LEVEL: CODEX_QUOTA_DISCOVERY.trust_level,
    OPERATOR_CAN_AUTHORIZE_CODEX: 'NO',
    CANARY_DIRECT_QUOTA_SQL: 'NO',
    REAL_CODEX_CALLS: 0,
    REAL_CURSOR_CALLS: 0,
  };
  process.stdout.write(JSON.stringify(out) + '\n');
  await pool.end().catch(() => undefined);
}

main().catch(async (e) => {
  process.stderr.write(String(e instanceof Error ? e.message : e) + '\n');
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
