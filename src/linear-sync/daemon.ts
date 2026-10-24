import { Pool } from 'pg';
import { readRequiredSecret } from '../core/read-secret-env.js';
import { LinearClient } from './linear-client.js';
import { syncBatch, type SyncConfig } from './sync.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_${name.toLowerCase()}`);
  return value;
}

const config: SyncConfig = {
  teamId: required('LINEAR_TEAM_ID'),
  projectId: required('LINEAR_PROJECT_ID'),
  states: {
    todo: required('LINEAR_STATE_TODO_ID'),
    progress: required('LINEAR_STATE_PROGRESS_ID'),
    review: required('LINEAR_STATE_REVIEW_ID'),
    done: required('LINEAR_STATE_DONE_ID'),
    canceled: required('LINEAR_STATE_CANCELED_ID'),
  },
  slackBotToken: readRequiredSecret('LINEAR_SYNC_SLACK_TOKEN_FILE', 'linear_sync_slack_token'),
};
const client = new LinearClient(readRequiredSecret('LINEAR_API_KEY_FILE', 'linear_api_key'));
const pool = new Pool({
  host: required('PGHOST'),
  port: Number(process.env.PGPORT ?? 5432),
  database: required('PGDATABASE'),
  user: required('PGUSER'),
  password: readRequiredSecret('LINEAR_SYNC_PG_PASSWORD_FILE', 'linear_sync_db_password'),
  max: 2,
  connectionTimeoutMillis: 10_000,
});

let stopping = false;
process.on('SIGTERM', () => { stopping = true; });
process.on('SIGINT', () => { stopping = true; });

async function main(): Promise<void> {
  do {
    try {
      const result = await syncBatch(pool, client, config);
      if (result.ok || result.failed) console.log(`linear_sync batch_ok=${result.ok} batch_failed=${result.failed}`);
    } catch {
      console.error('linear_sync status=batch_error');
    }
    if (process.argv.includes('--once')) break;
    await new Promise<void>(resolve => setTimeout(resolve, 60_000));
  } while (!stopping);
  await pool.end();
}

void main().catch(() => { console.error('linear_sync status=fatal'); process.exitCode = 1; });
