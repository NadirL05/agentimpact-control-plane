import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { issueIdFor, type MissionSource } from './core.js';
import type { LinearClient } from './linear-client.js';
import { syncSource, type SyncConfig } from './sync.js';

const source: MissionSource = {
  source_kind: 'agent_mission', source_id: 'b108c92e-72be-4d24-9153-00e389d16ba2',
  title: 'Audit infra', source_state: 'running', version: '2', project_name: 'INFRA',
  target_agent: 'hermes', channel_id: null, thread_ts: null,
  linear_issue_id: null, linear_identifier: null, linear_url: null,
  synced_hash: null, slack_notified_at: null, attempt_count: null,
};
const config: SyncConfig = {
  teamId: 'team', projectId: 'project', slackBotToken: 'unused',
  states: { todo: 'todo', progress: 'progress', review: 'review', done: 'done', canceled: 'canceled' },
};

describe('Linear mission delivery', () => {
  it('recovers a created issue after a lost response without making a duplicate', async () => {
    const id = issueIdFor(source.source_kind, source.source_id);
    const issue = { id, identifier: 'AGE-123', url: 'https://linear.app/agentimpact/issue/AGE-123' };
    const getIssue = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(issue);
    const createIssue = vi.fn().mockRejectedValueOnce(new Error('connection dropped'));
    const updateIssue = vi.fn();
    const client = { getIssue, createIssue, updateIssue } as unknown as LinearClient;
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const pool = { query } as unknown as Pool;

    await syncSource(pool, client, config, source);

    expect(getIssue).toHaveBeenCalledTimes(2);
    expect(getIssue).toHaveBeenCalledWith(id);
    expect(createIssue).toHaveBeenCalledTimes(1);
    expect(createIssue).toHaveBeenCalledWith(expect.objectContaining({ id, stateId: 'progress' }));
    expect(updateIssue).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO linear_mission_links'),
      expect.arrayContaining([id, 'AGE-123', issue.url]));
  });
});
