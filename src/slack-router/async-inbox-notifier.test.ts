import { describe, expect, it, vi } from 'vitest';
import { drainAsyncInboxNotifications } from './async-inbox-notifier.js';

describe('drainAsyncInboxNotifications', () => {
  it('poste démarrage puis résultat final sans double notification', async () => {
    const posts: string[] = [];
    const queries: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("status = 'processing'") && sql.includes('slack_started_at IS NULL')) {
          return {
            rows: [
              {
                id: 'm1',
                status: 'processing',
                channel_id: 'C1',
                thread_ts: '1.0',
                mission_title: 'IMANE-PROJECT-AUDIT-V1',
                response_text: null,
                error_code: null,
                slack_started_at: null,
                slack_notified_at: null,
                target: 'hermes',
              },
            ],
          };
        }
        if (sql.includes("status IN ('done', 'failed'")) {
          return {
            rows: [
              {
                id: 'm1',
                status: 'done',
                channel_id: 'C1',
                thread_ts: '1.0',
                mission_title: 'IMANE-PROJECT-AUDIT-V1',
                response_text: 'audit ok',
                error_code: null,
                slack_started_at: new Date(),
                slack_notified_at: null,
                target: 'hermes',
              },
            ],
          };
        }
        return { rows: [] };
      }),
    };

    const result = await drainAsyncInboxNotifications(pool as never, {
      postThreadReply: async (_c, _t, text) => {
        posts.push(text);
      },
    });

    expect(result.started).toBe(1);
    expect(result.finalized).toBe(1);
    expect(posts[0]).toContain('démarrée');
    expect(posts[1]).toContain('terminée');
    expect(posts[1]).toContain('audit ok');
    expect(queries.some((q) => q.includes('slack_started_at = now()'))).toBe(true);
    expect(queries.some((q) => q.includes('slack_notified_at = now()'))).toBe(true);
  });

  it('timeout transport → message failed sans relancer Hermès', async () => {
    const posts: string[] = [];
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("status = 'processing'")) return { rows: [] };
        if (sql.includes("status IN ('done', 'failed'")) {
          return {
            rows: [
              {
                id: 'm2',
                status: 'timeout',
                channel_id: 'C1',
                thread_ts: '1.0',
                mission_title: 'X',
                response_text: null,
                error_code: 'hermes_timeout',
                slack_started_at: new Date(),
                slack_notified_at: null,
                target: 'hermes',
              },
            ],
          };
        }
        return { rows: [] };
      }),
    };

    await drainAsyncInboxNotifications(pool as never, {
      postThreadReply: async (_c, _t, text) => {
        posts.push(text);
      },
    });
    expect(posts[0]).toContain('échouée');
    expect(posts[0]).toContain('hermes_timeout');
  });
});
