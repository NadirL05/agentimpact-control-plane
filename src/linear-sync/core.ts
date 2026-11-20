import { createHash } from 'node:crypto';

export type SourceKind = 'agent_mission' | 'async_inbox';
export type MissionSource = {
  source_kind: SourceKind;
  source_id: string;
  title: string;
  source_state: string;
  version: string;
  project_name: string | null;
  target_agent: string;
  channel_id: string | null;
  thread_ts: string | null;
  linear_issue_id: string | null;
  linear_identifier: string | null;
  linear_url: string | null;
  synced_hash: string | null;
  slack_notified_at: Date | null;
  attempt_count: number | null;
};

export type LinearState = 'todo' | 'progress' | 'review' | 'done' | 'canceled';

/** A stable UUIDv4 means a retry after a crash can find the same Linear issue. */
export function issueIdFor(kind: SourceKind, id: string): string {
  const bytes = createHash('sha256').update(`agentimpact-linear-v1:${kind}:${id}`).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function linearState(source: MissionSource): LinearState {
  const state = source.source_state;
  if (['completed', 'done'].includes(state)) return 'done';
  if (['cancelled', 'rejected'].includes(state)) return 'canceled';
  if (['reviewing', 'awaiting_nadir_approval', 'blocked', 'retry_wait', 'failed_permanent', 'failed', 'timeout'].includes(state)) return 'review';
  if (['running', 'processing', 'in_progress', 'cancel_requested', 'cancelling'].includes(state)) return 'progress';
  return 'todo';
}

export function slackThreadUrl(source: MissionSource): string | null {
  if (!source.channel_id || !source.thread_ts) return null;
  if (!/^[A-Z0-9]+$/.test(source.channel_id) || !/^\d+\.\d+$/.test(source.thread_ts)) return null;
  return `https://app.slack.com/archives/${source.channel_id}/p${source.thread_ts.replace('.', '')}`;
}

export function issueContent(source: MissionSource): { title: string; description: string; hash: string } {
  const agent = source.target_agent === 'ana' || source.target_agent === 'agentimpact-growth'
    ? 'Ana' : source.target_agent === 'hermes' || source.target_agent === 'nadir-operator'
      ? 'Hermes' : source.target_agent;
  const title = `[${agent}] ${(source.title || 'Mission').replace(/\s+/g, ' ').trim().slice(0, 170)}`;
  const thread = slackThreadUrl(source);
  const description = [
    'Suivi automatique d’une mission AgentImpact. Le control plane garde l’état de référence.',
    '',
    `- ID : \`${source.source_id}\``,
    `- Type : ${source.source_kind === 'async_inbox' ? 'mission longue Slack' : `mission V${source.version}`}`,
    `- Agent : ${agent}`,
    `- État AgentImpact : \`${source.source_state}\``,
    ...(source.project_name ? [`- Projet AgentImpact : ${source.project_name}`] : []),
    ...(thread ? [`- Fil Slack : ${thread}`] : []),
    '',
    'Les changements de statut dans Linear ne pilotent pas l’exécution de l’agent.',
  ].join('\n');
  return { title, description, hash: createHash('sha256').update(JSON.stringify([title, description, linearState(source)])).digest('hex') };
}
