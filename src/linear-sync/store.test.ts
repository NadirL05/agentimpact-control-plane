import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { database } from '../core/missions-v2/testing/database.js';
import { MissionStore } from '../core/missions-v2/store.js';
import { candidates } from './store.js';

async function migrate(db: { exec: (sql: string) => Promise<unknown> }) {
  await db.exec(await readFile(new URL('../migrations/010_linear_mission_sync.sql', import.meta.url), 'utf8'));
}

describe('Linear mission source selection', () => {
  it('includes V1 missions and long Slack missions, but no ordinary inbox turns', async () => {
    const fixture = await database(undefined, false);
    try {
      await migrate(fixture.db);
      await fixture.db.query("INSERT INTO agent_actions(id) VALUES('99999999-9999-4999-8999-999999999999')");
      await fixture.db.query(`INSERT INTO agent_missions(action_id,target_agent,source_type,source_id,title)
        VALUES('99999999-9999-4999-8999-999999999999','dev-senior','command','test','Build release')`);
      await fixture.db.query(`INSERT INTO slack_gateway_inbox(target,prompt,channel_id,thread_ts,user_id,event_id,delivery_mode,mission_title)
        VALUES('hermes','private prompt','C123','123.456','U123','E1','async','Audit infra'),
              ('hermes','ordinary chat','C123','123.457','U123','E2','sync',NULL)`);
      const rows = await candidates(fixture.pool);
      expect(rows.map(row => row.source_kind).sort()).toEqual(['agent_mission', 'async_inbox']);
      expect(JSON.stringify(rows)).not.toContain('private prompt');
      expect(JSON.stringify(rows)).not.toContain('ordinary chat');
    } finally { await fixture.db.close(); }
  }, 20_000);

  it('includes V2 missions without duplicating their inbox record', async () => {
    const fixture = await database();
    try {
      await migrate(fixture.db);
      const store = new MissionStore(fixture.pool, { enabled: true, projects: new Set(['INFRA']) });
      const mission = await store.admit({ project: 'INFRA', title: 'Check deploy', objective: 'Check deploy status',
        source_type: 'slack', source_id: 'T1:E1' }, { principal: 'slack:T1:U1', key: 'slack:T1:E1' },
      { team_id: 'T1', event_id: 'E1', channel: 'C123', user: 'U1', thread_ts: '123.456', is_root: true });
      const rows = await candidates(fixture.pool);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ source_kind: 'agent_mission', source_id: mission.id,
        version: '2', channel_id: 'C123', thread_ts: '123.456' });
    } finally { await fixture.db.close(); }
  }, 20_000);
});
