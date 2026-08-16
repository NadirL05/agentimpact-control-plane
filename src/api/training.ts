/**
 * Suivi sport de Nadir, remigre depuis l'orchestrateur legacy (arrete le
 * 16/08/2026) vers le control-plane. Postgres au lieu de Notion : reste
 * coherent avec le reste du stack, pas de nouvelle integration externe.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { pool } from './db.js';
import { postMessage, slackConfigured } from './slack.js';

const app = new Hono();

const DAY_LABELS: Record<string, string> = {
  upper_a: 'Upper A',
  lower_a: 'Lower A',
  upper_b: 'Upper B',
  lower_b: 'Lower B',
};

const exerciseSchema = z.object({
  nom: z.string().min(1),
  poids_kg: z.number().nonnegative().optional(),
  series: z.number().int().positive().optional(),
  reps: z.string().optional(),
});

const logSchema = z.object({
  session_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  day_type: z.enum(['upper_a', 'lower_a', 'upper_b', 'lower_b']),
  exercises: z.array(exerciseSchema).min(1),
  notes: z.string().max(2000).optional(),
});

app.post('/log', async (c) => {
  const parsed = logSchema.safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
  }

  const { session_date: date, day_type: dayType, exercises, notes } = parsed.data;

  const inserted = await pool.query<{ id: string }>(
    `insert into training_sessions (session_date, day_type, exercises, notes)
     values ($1, $2, $3::jsonb, $4)
     returning id`,
    [date, dayType, JSON.stringify(exercises), notes ?? null],
  );

  if (slackConfigured()) {
    const lines = exercises
      .map((e) => `• ${e.nom}${e.poids_kg ? ` — ${e.poids_kg}kg` : ''}${e.series ? ` × ${e.series}` : ''}${e.reps ? ` (${e.reps})` : ''}`)
      .join('\n');
    await postMessage(
      `💪 Séance loggée : *${DAY_LABELS[dayType]}* (${date})\n${lines}${notes ? `\n_${notes}_` : ''}`,
    );
  }

  return c.json({ ok: true, id: inserted.rows[0].id });
});

app.get('/week', async (c) => {
  const result = await pool.query(
    `select session_date, day_type, exercises, notes
       from training_sessions
      where session_date > now() - interval '8 days'
      order by session_date desc`,
  );

  return c.json({ count: result.rows.length, items: result.rows });
});

export default app;
