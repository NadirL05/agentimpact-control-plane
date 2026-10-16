import type { Pool } from 'pg';
import type { MissionSource, SourceKind } from './core.js';
import type { LinearIssue } from './linear-client.js';

/** V1, V2 and long-running Slack inbox rows. Ordinary chat turns are excluded. */
const CANDIDATES = `
WITH sources AS (
  SELECT 'agent_mission'::text AS source_kind, m.id AS source_id, m.title,
    coalesce(nullif(to_jsonb(m)->>'lifecycle_state',''),m.status) AS source_state,
    coalesce(to_jsonb(m)->>'orchestration_version','1') AS version,
    to_jsonb(m)->>'project' AS project_name, m.target_agent,
    (SELECT i.channel_id FROM slack_gateway_inbox i
      WHERE to_jsonb(i)->>'mission_id'=m.id::text LIMIT 1) AS channel_id,
    (SELECT i.thread_ts FROM slack_gateway_inbox i
      WHERE to_jsonb(i)->>'mission_id'=m.id::text LIMIT 1) AS thread_ts,
    m.created_at, m.updated_at
  FROM agent_missions m
  UNION ALL
  SELECT 'async_inbox', i.id, coalesce(nullif(i.mission_title,''),'Mission longue'),
    i.status, '1', NULL, i.target, i.channel_id, i.thread_ts,
    i.created_at, i.updated_at
  FROM slack_gateway_inbox i
  WHERE i.delivery_mode='async'
    AND coalesce(to_jsonb(i)->>'orchestration_version','1')='1'
)
SELECT s.source_kind,s.source_id,s.title,s.source_state,s.version,s.project_name,
  s.target_agent,s.channel_id,s.thread_ts,
  l.linear_issue_id,l.linear_identifier,l.linear_url,l.synced_hash,
  l.slack_notified_at,l.attempt_count
FROM sources s
LEFT JOIN linear_mission_links l
  ON l.source_kind=s.source_kind AND l.source_id=s.source_id
WHERE (l.synced_at IS NULL OR s.updated_at>l.synced_at
  OR (s.channel_id IS NOT NULL AND l.slack_notified_at IS NULL))
  AND (l.retry_after IS NULL OR l.retry_after<=now())
ORDER BY s.created_at,s.source_id
LIMIT $1`;

export async function candidates(pool: Pool, limit = 50): Promise<MissionSource[]> {
  const result = await pool.query<MissionSource>(CANDIDATES, [limit]);
  return result.rows;
}

export async function saveSynced(pool: Pool, source: MissionSource, issue: LinearIssue, hash: string): Promise<void> {
  await pool.query(`INSERT INTO linear_mission_links
      (source_kind,source_id,linear_issue_id,linear_identifier,linear_url,synced_hash,synced_at)
    VALUES ($1,$2,$3,$4,$5,$6,now())
    ON CONFLICT (source_kind,source_id) DO UPDATE SET
      linear_identifier=EXCLUDED.linear_identifier,linear_url=EXCLUDED.linear_url,
      synced_hash=EXCLUDED.synced_hash,synced_at=now(),attempt_count=0,
      retry_after=NULL,error_code=NULL,updated_at=now()`,
    [source.source_kind, source.source_id, issue.id, issue.identifier, issue.url, hash]);
}

export async function markSlackNotified(pool: Pool, kind: SourceKind, id: string): Promise<void> {
  await pool.query(`UPDATE linear_mission_links
    SET slack_notified_at=now(),updated_at=now()
    WHERE source_kind=$1 AND source_id=$2 AND slack_notified_at IS NULL`, [kind, id]);
}

export async function recordFailure(pool: Pool, source: MissionSource, issueId: string, code: string): Promise<void> {
  const attempts = (source.attempt_count ?? 0) + 1;
  const delaySeconds = Math.min(1800, 10 * 2 ** Math.min(attempts - 1, 8));
  await pool.query(`INSERT INTO linear_mission_links
      (source_kind,source_id,linear_issue_id,attempt_count,retry_after,error_code)
    VALUES ($1,$2,$3,$4,now()+$5::integer*interval '1 second',$6)
    ON CONFLICT (source_kind,source_id) DO UPDATE SET
      attempt_count=$4,retry_after=now()+$5::integer*interval '1 second',
      error_code=$6,updated_at=now()`,
    [source.source_kind,source.source_id,issueId,attempts,delaySeconds,code.slice(0,80)]);
}
