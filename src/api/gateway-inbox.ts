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
      delivery_mode: string;
      mission_title: string | null;
    }>(
      `SELECT id, prompt, channel_id, thread_ts, user_id, event_id,
              coalesce(delivery_mode, 'sync') as delivery_mode,
              mission_title
       FROM slack_gateway_inbox i
       WHERE coalesce(to_jsonb(i)->>'orchestration_version', '1') = '1' AND target = $1 AND status = 'pending'
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
      `UPDATE slack_gateway_inbox i SET status = 'processing', updated_at = now() WHERE id = $1 AND coalesce(to_jsonb(i)->>'orchestration_version', '1') = '1'`,
      [row.id],
    );
    await client.query('COMMIT');

    return c.json({
      item: {
        id: row.id,
        orchestration_version: 1,
        target,
        prompt: row.prompt,
        channel_id: row.channel_id,
        thread_ts: row.thread_ts,
        user_id: row.user_id,
        event_id: row.event_id,
        delivery_mode: row.delivery_mode,
        mission_title: row.mission_title,
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
    | { text?: string; run_id?: string; error_code?: string; status?: string }
    | null;

  if (!body) {
    return c.json({ error: 'invalid_body' }, 400);
  }

  if (body.text && body.text.trim()) {
    const result = await pool.query(
      `UPDATE slack_gateway_inbox i
       SET status = 'done', response_text = $2, run_id = $3, updated_at = now()
       WHERE id = $1 AND coalesce(to_jsonb(i)->>'orchestration_version', '1') = '1' AND status = 'processing'`,
      [id, body.text.trim(), body.run_id ?? null],
    );
    if (!result.rowCount) return c.json({ error: 'inbox_not_processable' }, 409);
    return c.json({ ok: true });
  }

  const errorCode = (body.error_code ?? 'consumer_failed').slice(0, 120);
  const terminal =
    body.status === 'timeout' || errorCode === 'hermes_timeout' || errorCode === 'inbox_timeout'
      ? 'timeout'
      : body.status === 'cancelled'
        ? 'cancelled'
        : 'failed';

  const result = await pool.query(
    `UPDATE slack_gateway_inbox i
     SET status = $2, error_code = $3, updated_at = now()
     WHERE id = $1 AND coalesce(to_jsonb(i)->>'orchestration_version', '1') = '1' AND status = 'processing'`,
    [id, terminal, errorCode],
  );
  if (!result.rowCount) return c.json({ error: 'inbox_not_processable' }, 409);
  return c.json({ ok: true });
});

export default app;
