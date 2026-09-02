/**
 * API inbox gateway Hermès/Ana — localhost + token bridge uniquement.
 * Consommée par infra/scripts/gateway-inbox-consumer.py côté gateway.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../core/hono-env.js';
import { pool } from './db.js';

const app = new Hono<AppEnv>();

app.post('/claim', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { target?: string } | null;
  const target = body?.target?.trim();
  if (target !== 'hermes' && target !== 'ana') {
    return c.json({ error: 'invalid_target' }, 400);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claimed = await client.query<{
      id: string;
      prompt: string;
      channel_id: string;
      thread_ts: string;
      user_id: string;
      event_id: string;
    }>(
      `SELECT id, prompt, channel_id, thread_ts, user_id, event_id
       FROM slack_gateway_inbox
       WHERE target = $1 AND status = 'pending'
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [target],
    );

    if ((claimed.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return c.body(null, 204);
    }

    const row = claimed.rows[0]!;
    await client.query(
      `UPDATE slack_gateway_inbox SET status = 'processing', updated_at = now() WHERE id = $1`,
      [row.id],
    );
    await client.query('COMMIT');

    return c.json({
      item: {
        id: row.id,
        target,
        prompt: row.prompt,
        channel_id: row.channel_id,
        thread_ts: row.thread_ts,
        user_id: row.user_id,
        event_id: row.event_id,
      },
    });
  } catch {
    await client.query('ROLLBACK');
    return c.json({ error: 'claim_failed' }, 503);
  } finally {
    client.release();
  }
});

app.post('/:id/complete', async (c) => {
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => null)) as
    | { text?: string; run_id?: string; error_code?: string }
    | null;

  if (!body) {
    return c.json({ error: 'invalid_body' }, 400);
  }

  if (body.text && body.text.trim()) {
    await pool.query(
      `UPDATE slack_gateway_inbox
       SET status = 'done', response_text = $2, run_id = $3, updated_at = now()
       WHERE id = $1 AND status = 'processing'`,
      [id, body.text.trim(), body.run_id ?? null],
    );
    return c.json({ ok: true });
  }

  await pool.query(
    `UPDATE slack_gateway_inbox
     SET status = 'failed', error_code = $2, updated_at = now()
     WHERE id = $1 AND status = 'processing'`,
    [id, body.error_code ?? 'consumer_failed'],
  );
  return c.json({ ok: true });
});

export default app;
