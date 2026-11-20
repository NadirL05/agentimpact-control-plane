import { describe, expect, it } from 'vitest';
import { issueContent, issueIdFor, linearState, slackThreadUrl, type MissionSource } from './core.js';

function source(overrides: Partial<MissionSource> = {}): MissionSource {
  return {
    source_kind: 'agent_mission',
    source_id: 'b108c92e-72be-4d24-9153-00e389d16ba2',
    title: 'Vérifier le déploiement',
    source_state: 'queued',
    version: '2',
    project_name: 'INFRA',
    target_agent: 'hermes',
    channel_id: 'C12345',
    thread_ts: '1729000000.123456',
    linear_issue_id: null,
    linear_identifier: null,
    linear_url: null,
    synced_hash: null,
    slack_notified_at: null,
    attempt_count: null,
    ...overrides,
  };
}

describe('Linear mission projection', () => {
  it('assigns a stable, distinct UUIDv4 per source', () => {
    const id = issueIdFor('agent_mission', source().source_id);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(issueIdFor('agent_mission', source().source_id)).toBe(id);
    expect(issueIdFor('async_inbox', source().source_id)).not.toBe(id);
  });

  it('maps terminal failures to review so they stay actionable', () => {
    expect(linearState(source({ source_state: 'failed_permanent' }))).toBe('review');
    expect(linearState(source({ source_state: 'completed' }))).toBe('done');
    expect(linearState(source({ source_state: 'cancelled' }))).toBe('canceled');
    expect(linearState(source({ source_state: 'running' }))).toBe('progress');
  });

  it('projects a bounded title, state and Slack link without mission body', () => {
    const item = issueContent(source());
    expect(item.title).toBe('[Hermes] Vérifier le déploiement');
    expect(item.description).toContain('https://app.slack.com/archives/C12345/p1729000000123456');
    expect(item.description).toContain('État AgentImpact : `queued`');
    expect(item.description).not.toContain('prompt');
    expect(slackThreadUrl(source({ thread_ts: 'invalid' }))).toBeNull();
  });
});
