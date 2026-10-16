import type { Pool } from 'pg';
import { issueContent, issueIdFor, linearState, slackThreadUrl,
  type LinearState, type MissionSource } from './core.js';
import { LinearClient, LinearApiError, postSlackLink, type LinearIssue } from './linear-client.js';
import { candidates, markSlackNotified, recordFailure, saveSynced } from './store.js';

export type SyncConfig = {
  teamId: string;
  projectId: string;
  states: Record<LinearState, string>;
  slackBotToken: string;
};

export async function syncSource(pool: Pool, client: LinearClient, config: SyncConfig,
  source: MissionSource): Promise<void> {
  const id = issueIdFor(source.source_kind, source.source_id);
  if (source.linear_issue_id && source.linear_issue_id !== id) throw new Error('linear_mapping_conflict');
  const content = issueContent(source);
  let issue: LinearIssue;
  if (!source.linear_url || source.synced_hash !== content.hash) {
    const existing = await client.getIssue(id);
    if (existing) {
      issue = await client.updateIssue(id, {
        stateId: config.states[linearState(source)],
        title: content.title,
        description: content.description,
      });
    } else {
      try {
        issue = await client.createIssue({
          id, teamId: config.teamId, projectId: config.projectId,
          stateId: config.states[linearState(source)],
          title: content.title, description: content.description,
        });
      } catch (error) {
        // If Linear committed the create but our connection dropped, recover by ID.
        const recovered = await client.getIssue(id);
        if (!recovered) throw error;
        issue = recovered;
      }
    }
    await saveSynced(pool, source, issue, content.hash);
  } else {
    issue = { id, identifier: source.linear_identifier!, url: source.linear_url };
    // A source row can change without changing the projected fields.
    await saveSynced(pool, source, issue, content.hash);
  }
  if (slackThreadUrl(source) && !source.slack_notified_at) {
    await postSlackLink(config.slackBotToken, source.channel_id!, source.thread_ts!, issue);
    await markSlackNotified(pool, source.source_kind, source.source_id);
  }
}

export async function syncBatch(pool: Pool, client: LinearClient, config: SyncConfig,
  log: (line: string) => void = console.log): Promise<{ ok: number; failed: number }> {
  const rows = await candidates(pool);
  let ok = 0;
  let failed = 0;
  for (const source of rows) {
    try {
      await syncSource(pool, client, config, source);
      ok += 1;
    } catch (error) {
      failed += 1;
      const code = error instanceof LinearApiError ? error.code
        : error instanceof Error && error.message === 'linear_mapping_conflict'
          ? 'linear_mapping_conflict' : 'sync_error';
      await recordFailure(pool, source, issueIdFor(source.source_kind, source.source_id), code);
      log(`linear_sync source=${source.source_kind} id=${source.source_id} status=failed code=${code}`);
    }
  }
  return { ok, failed };
}
