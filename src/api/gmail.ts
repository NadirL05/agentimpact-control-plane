/**
 * Lecture Gmail (semaine 1-2 phase Growth) : expose fetchRecentReplies au
 * poller. Lecture seule ; aucune route d'envoi.
 */

import { Hono } from 'hono';
import { fetchRecentReplies } from './google.js';

const app = new Hono();

app.get('/replies', async (c) => {
  const query = c.req.query('q') ?? 'in:inbox newer_than:15m';

  try {
    const messages = await fetchRecentReplies(query, 30);
    return c.json({ count: messages.length, items: messages });
  } catch (error) {
    return c.json(
      { error: 'gmail_unreachable', message: error instanceof Error ? error.message : '' },
      502,
    );
  }
});

export default app;
