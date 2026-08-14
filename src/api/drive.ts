/**
 * Drive Intelligence controlee (semaine 5 de la roadmap).
 *
 * Contraintes tenues ici :
 *  - aucun delete, aucun partage externe : seul le deplacement existe ;
 *  - aucun deplacement sans action approuvee (statut `approved`) ;
 *  - un seul dossier cible par lot ;
 *  - les parents d'origine sont enregistres avant le deplacement, donc le
 *    rollback est exact et non "au mieux".
 */

import { Hono } from 'hono';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool } from './db.js';
import { driveGet, driveMove, driveSearch } from './google.js';
import { postMessage, slackConfigured } from './slack.js';
import { FOLDER_MIME, buildMovePlan, type MovePlan } from '../core/drive-plan.js';

const app = new Hono();

const PROFILE = 'nadir-operator';
const MAX_BATCH = Number(process.env.DRIVE_MAX_BATCH ?? 20);

const proposeSchema = z.object({
  query: z.string().min(2).max(500),
  destination_folder_id: z.string().min(5),
  reason: z.string().min(3).max(500),
  limit: z.number().int().min(1).max(MAX_BATCH).optional(),
});

const executeSchema = z.object({ action_id: z.string().uuid() });

async function recordAction(
  intent: string,
  payload: unknown,
  targets: string[],
  status: 'proposed' | 'executing',
): Promise<{ id: string; payload_hash: string }> {
  const payloadHash = createHash('sha256')
    .update(JSON.stringify({ payload, nonce: randomUUID() }))
    .digest('hex');

  const result = await pool.query<{ id: string; payload_hash: string }>(
    `insert into agent_actions
       (profile, intent, targets, payload, payload_hash, risk_level, dry_run, status)
     values ($1, $2, $3::jsonb, $4::jsonb, $5, 'reversible_write', false, $6)
     returning id, payload_hash`,
    [PROFILE, intent, JSON.stringify(targets), JSON.stringify(payload), payloadHash, status],
  );

  return result.rows[0];
}

async function logEvent(
  actionId: string,
  eventType: 'created' | 'executing' | 'executed' | 'failed',
  stage: string,
  details: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `insert into agent_audit_events (action_id, event_type, actor, details)
     values ($1, $2, $3, $4::jsonb)`,
    [actionId, eventType, PROFILE, JSON.stringify({ stage, ...details })],
  );
}

/** Recherche Drive, lecture seule. */
app.get('/search', async (c) => {
  const query = c.req.query('q');

  if (!query) return c.json({ error: 'q_required' }, 400);

  try {
    const files = await driveSearch(query, 25);
    return c.json({ count: files.length, items: files });
  } catch (error) {
    return c.json(
      { error: 'drive_unreachable', message: error instanceof Error ? error.message : 'erreur' },
      502,
    );
  }
});

/**
 * Prepare un classement : rien n'est deplace ici. On produit un plan complet
 * (fichier par fichier, avec ses parents actuels) soumis a validation humaine.
 */
app.post('/propose', async (c) => {
  const parsed = proposeSchema.safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
  }

  const { query, destination_folder_id: destination, reason, limit } = parsed.data;

  let destinationName: string;

  try {
    const folder = await driveGet(destination);
    if (folder.mimeType !== FOLDER_MIME) {
      return c.json({ error: 'destination_not_a_folder', mime_type: folder.mimeType }, 400);
    }
    destinationName = folder.name;
  } catch (error) {
    return c.json(
      { error: 'destination_unreachable', message: error instanceof Error ? error.message : '' },
      502,
    );
  }

  let files;
  try {
    // trashed=false : on ne touche jamais a la corbeille.
    files = await driveSearch(`(${query}) and trashed = false`, limit ?? MAX_BATCH);
  } catch (error) {
    return c.json(
      { error: 'drive_unreachable', message: error instanceof Error ? error.message : '' },
      502,
    );
  }

  const moves: MovePlan[] = buildMovePlan(files, destination, MAX_BATCH);

  if (moves.length === 0) {
    return c.json({
      ok: true,
      moves: [],
      message: 'Aucun fichier à déplacer (déjà classés, ou requête sans résultat).',
    });
  }

  const payload = {
    query,
    reason,
    destination: { id: destination, name: destinationName },
    moves,
  };

  const action = await recordAction(
    'drive_move_files',
    payload,
    moves.map((m) => m.file_id),
    'proposed',
  );

  await logEvent(action.id, 'created', 'drive_move_proposed', {
    file_count: moves.length,
    destination,
  });

  if (slackConfigured()) {
    await postMessage(
      `Classement Drive proposé : ${moves.length} fichier(s) vers *${destinationName}*\n` +
        `Motif : ${reason}\n` +
        moves
          .slice(0, 10)
          .map((m) => `• ${m.name}`)
          .join('\n') +
        `\n\nValider : \`!approve ${action.id}\` · Refuser : \`!reject ${action.id} <raison>\``,
    );
  }

  return c.json({
    ok: true,
    action_id: action.id,
    payload_hash: action.payload_hash,
    destination: { id: destination, name: destinationName },
    moves,
  });
});

/** Execute un classement deja approuve. Refuse tout ce qui ne l'est pas. */
app.post('/execute', async (c) => {
  const parsed = executeSchema.safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
  }

  const { action_id: actionId } = parsed.data;

  const result = await pool.query<{
    id: string;
    intent: string;
    status: string;
    payload: { destination: { id: string; name: string }; moves: MovePlan[] };
  }>(
    `select id, intent, status, payload from agent_actions where id = $1`,
    [actionId],
  );

  const action = result.rows[0];

  if (!action) return c.json({ error: 'action_not_found' }, 404);
  if (action.intent !== 'drive_move_files') {
    return c.json({ error: 'wrong_intent', intent: action.intent }, 400);
  }
  if (action.status !== 'approved') {
    return c.json(
      {
        error: 'not_approved',
        status: action.status,
        message: 'Un classement ne s exécute qu apres validation humaine.',
      },
      403,
    );
  }

  await pool.query(`update agent_actions set status = 'executing' where id = $1`, [actionId]);

  const moved: Array<{ file_id: string; previous_parents: string[] }> = [];
  const failures: Array<{ file_id: string; error: string }> = [];

  for (const move of action.payload.moves) {
    try {
      const outcome = await driveMove(move.file_id, move.to_parent, move.from_parents);
      moved.push({ file_id: move.file_id, previous_parents: outcome.previousParents });
    } catch (error) {
      failures.push({
        file_id: move.file_id,
        error: error instanceof Error ? error.message : 'erreur',
      });
    }
  }

  const status = failures.length === 0 ? 'executed' : 'failed';

  await pool.query(
    `update agent_actions
        set status = $2,
            executed_at = now(),
            error_message = $3,
            payload = payload || $4::jsonb
      where id = $1`,
    [
      actionId,
      status,
      failures.length > 0 ? `${failures.length} deplacement(s) en echec` : null,
      JSON.stringify({ rollback: moved }),
    ],
  );

  await logEvent(actionId, status === 'executed' ? 'executed' : 'failed', 'drive_move_done', {
    moved: moved.length,
    failed: failures.length,
  });

  if (slackConfigured()) {
    await postMessage(
      `Classement Drive exécuté : ${moved.length} fichier(s) déplacé(s) vers *${action.payload.destination.name}*` +
        (failures.length > 0 ? `, ${failures.length} échec(s)` : '') +
        `\nRollback possible : \`POST /api/drive/rollback\` avec \`${actionId}\``,
    );
  }

  return c.json({ ok: failures.length === 0, moved: moved.length, failures });
});

/** Remet chaque fichier dans ses parents d'origine. */
app.post('/rollback', async (c) => {
  const parsed = executeSchema.safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
  }

  const { action_id: actionId } = parsed.data;

  const result = await pool.query<{
    id: string;
    status: string;
    payload: {
      destination: { id: string };
      rollback?: Array<{ file_id: string; previous_parents: string[] }>;
    };
  }>(`select id, status, payload from agent_actions where id = $1`, [actionId]);

  const action = result.rows[0];

  if (!action) return c.json({ error: 'action_not_found' }, 404);

  const rollbackPlan = action.payload.rollback ?? [];

  if (rollbackPlan.length === 0) {
    return c.json({ error: 'nothing_to_rollback', status: action.status }, 409);
  }

  const restored: string[] = [];
  const failures: Array<{ file_id: string; error: string }> = [];

  for (const entry of rollbackPlan) {
    try {
      // Les parents d'origine ont ete captures avant le deplacement.
      for (const parent of entry.previous_parents) {
        await driveMove(entry.file_id, parent, [action.payload.destination.id]);
      }
      restored.push(entry.file_id);
    } catch (error) {
      failures.push({
        file_id: entry.file_id,
        error: error instanceof Error ? error.message : 'erreur',
      });
    }
  }

  await pool.query(
    `update agent_actions set status = 'rolled_back', error_message = $2 where id = $1`,
    [actionId, failures.length > 0 ? `${failures.length} rollback(s) en echec` : null],
  );

  await logEvent(actionId, 'executed', 'drive_rollback', {
    restored: restored.length,
    failed: failures.length,
  });

  if (slackConfigured()) {
    await postMessage(
      `Rollback Drive : ${restored.length} fichier(s) remis à leur emplacement d'origine` +
        (failures.length > 0 ? `, ${failures.length} échec(s)` : ''),
    );
  }

  return c.json({ ok: failures.length === 0, restored: restored.length, failures });
});

export default app;
