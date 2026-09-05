import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

export async function database(path?: string, v2 = true) {
  const db = new PGlite(path);
  await db.waitReady;
  const present = await db.query("SELECT to_regclass('public.agent_missions') AS name");
  if (!(present.rows[0] as {name: string | null}).name) {
    await db.exec(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
    for (const file of ['001_cursor_proposals.sql','002_slack_router.sql','003_async_long_running_missions.sql',...(v2 ? ['004_v2_mission_foundation.sql'] : [])]) {
      await db.exec(await readFile(new URL(`../../../migrations/${file}`,import.meta.url),'utf8'));
    }
  }
  // PGlite uses the PostgreSQL engine with one connection. Serialize entire test
  // transactions; native multi-connection contention is a separate rollout check.
  let tail = Promise.resolve();
  let fault: 'before_commit' | 'after_commit' | undefined;
  async function query(sql: string, params?: unknown[]) {
    if (sql === 'COMMIT' && fault === 'before_commit') { fault=undefined; throw new Error('simulated_crash'); }
    const r = await db.query(sql,params);
    if (sql === 'COMMIT' && fault === 'after_commit') { fault=undefined; throw new Error('simulated_connection_loss'); }
    return {...r,rowCount:r.rows.length || r.affectedRows || 0};
  }
  const pool = {
    query,
    async connect() {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => {release=resolve;});
      await previous;
      return {query,release};
    },
  } as unknown as Pool;
  return {db,pool,crash(at: typeof fault) {fault=at;}};
}
