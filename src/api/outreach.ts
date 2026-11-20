/**
 * Envoi et suivi des campagnes (semaine 1-2 phase Growth).
 *
 * Un brouillon devient un envoi seulement si : l'action liee est approuvee,
 * l'adresse n'est pas supprimee, et le quota du jour n'est pas depasse. Les
 * trois controles sont revérifies ici — jamais supposes acquis depuis un
 * appelant.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { pool } from './db.js';
import { brevoConfigured, sendTransactional } from './brevo.js';
import { canSend, classifyReply, type SendVerdict } from '../core/outreach-guards.js';
import { constantTimeEqualString } from '../core/secure-compare.js';
import { postMessage, slackConfigured } from './slack.js';

const app = new Hono();

const PROFILE = 'agentimpact-growth';
// Premier envoi reel : ajuster une fois la date de lancement connue.
const LAUNCH_DATE = process.env.OUTREACH_LAUNCH_DATE
  ? new Date(process.env.OUTREACH_LAUNCH_DATE)
  : null;

function daysSinceLaunch(): number {
  if (!LAUNCH_DATE) return -1;
  return Math.floor((Date.now() - LAUNCH_DATE.getTime()) / 86_400_000);
}

async function logEvent(
  actionId: string | null,
  eventType: 'created' | 'executed' | 'failed' | 'blocked_by_policy',
  stage: string,
  details: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `insert into agent_audit_events (action_id, event_type, actor, details)
     values ($1, $2, $3, $4::jsonb)`,
    [actionId, eventType, PROFILE, JSON.stringify({ stage, ...details })],
  );
}

const sendSchema = z.object({ draft_id: z.string().uuid() });

async function addSuppression(email:string,reason:string,source:string):Promise<void> {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`select pg_advisory_xact_lock(hashtextextended(lower($1),0))`,[email]);
    await client.query(`insert into suppression_list (email, reason, source)
      values ($1,$2,$3) on conflict (email) do nothing`,[email,reason,source]);
    await client.query('COMMIT');
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>undefined);
    throw error;
  } finally { client.release(); }
}

/** Envoie un brouillon deja approuve. */
app.post('/send', async (c) => {
  if (!brevoConfigured()) return c.json({ error: 'missing_brevo_api_key' }, 503);

  const parsed = sendSchema.safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
  }

  const { draft_id: draftId } = parsed.data;

  const result = await pool.query<{
    id: string;
    action_id: string | null;
    channel: string;
    subject: string | null;
    body: string;
    status: string;
    to_email: string | null;
    lead_id: string | null;
    action_status: string | null;
  }>(
    `select d.id, d.action_id, d.channel, d.subject, d.body, d.status,
            coalesce(d.to_email, l.email) as to_email, d.lead_id, a.status as action_status
       from outreach_drafts d
       left join leads l on l.id = d.lead_id
       left join agent_actions a on a.id = d.action_id
      where d.id = $1`,
    [draftId],
  );

  const draft = result.rows[0];

  if (!draft) return c.json({ error: 'draft_not_found' }, 404);
  if (draft.channel !== 'email') {
    return c.json({ error: 'unsupported_channel', channel: draft.channel }, 400);
  }
  if (draft.status === 'sent') {
    return c.json({ error: 'already_sent' }, 409);
  }
  if (!draft.action_id || draft.action_status !== 'approved') {
    return c.json(
      { error: 'not_approved', message: 'Ce brouillon n a pas ete valide.' },
      403,
    );
  }
  if (!draft.to_email) {
    return c.json({ error: 'no_recipient_email' }, 422);
  }

  // The advisory transaction lock serializes the quota observation and the
  // durable execution reservation across distinct drafts. In-flight sends are
  // counted, so concurrent requests cannot all observe the same remaining slot.
  const client = await pool.connect();
  let blocked: Extract<SendVerdict,{allowed:false}> | undefined;
  let claimed = false;
  try {
    await client.query('BEGIN');
    await client.query(`select pg_advisory_xact_lock(hashtext('agentimpact-outreach-daily-quota'))`);
    await client.query(`select pg_advisory_xact_lock(hashtextextended(lower($1),0))`,[draft.to_email]);
    const suppressed = await client.query(
      `select 1 from suppression_list where lower(email) = lower($1) limit 1`,
      [draft.to_email],
    );
    const count = await client.query<{n:string}>(`select count(*)::text as n
      from outreach_drafts d
      left join agent_actions a on a.id=d.action_id
      where (d.sent_at is not null and d.sent_at::date=current_date)
         or (d.sent_at is null and a.status='executing' and a.execution_claimed_at::date=current_date)`);
    const verdict = canSend({
      isSuppressed: Boolean(suppressed.rowCount),
      sentToday: Number(count.rows[0]?.n ?? 0),
      daysSinceLaunch: daysSinceLaunch(),
    });
    if (!verdict.allowed) {
      blocked = verdict;
      await client.query('ROLLBACK');
    } else {
      const claim = await client.query(`update agent_actions
        set status='executing',execution_claimed_at=clock_timestamp(),execution_claimed_by=$2
        where id=$1 and status='approved' and approval_expires_at>clock_timestamp()
          and exists (select 1 from agent_approvals p where p.action_id=agent_actions.id
            and p.payload_hash=agent_actions.payload_hash and p.decision='approved'
            and p.expires_at>clock_timestamp())
        returning id`,[draft.action_id,PROFILE]);
      claimed=Boolean(claim.rowCount);
      if(claimed) await client.query('COMMIT'); else await client.query('ROLLBACK');
    }
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>undefined);
    throw error;
  } finally {
    client.release();
  }
  if (blocked) {
    await logEvent(draft.action_id, 'blocked_by_policy', 'outreach_send_blocked', {
      draft_id: draftId,
      reason: blocked.reason,
    });
    return c.json({ error: blocked.reason }, blocked.httpStatus);
  }
  if (!claimed) return c.json({ error: 'send_already_claimed' }, 409);

  // Re-acquire the per-recipient lock after the durable claim and hold it
  // across the provider side effect. Suppression writers take the same lock,
  // giving a single linear order: suppression-before-send blocks; a signal
  // arriving after provider execution waits and protects all future sends.
  const sendClient=await pool.connect();
  let sendResult:Awaited<ReturnType<typeof sendTransactional>>;
  try {
    await sendClient.query('BEGIN');
    await sendClient.query(`select pg_advisory_xact_lock(hashtextextended(lower($1),0))`,[draft.to_email]);
    const suppressed=await sendClient.query(`select 1 from suppression_list where lower(email)=lower($1) limit 1`,[draft.to_email]);
    if(suppressed.rowCount) {
      await sendClient.query(`update agent_actions set status='failed',error_message='suppressed_before_provider'
        where id=$1 and status='executing'`,[draft.action_id]);
      await sendClient.query('COMMIT');
      await logEvent(draft.action_id,'blocked_by_policy','outreach_send_blocked',{
        draft_id:draftId,reason:'suppressed',phase:'before_provider',
      });
      return c.json({error:'suppressed'},409);
    }

    sendResult = await sendTransactional({
      to: draft.to_email,
      subject: draft.subject ?? '(sans objet)',
      textContent: draft.body,
      headers: { 'X-AgentImpact-Draft-Id': draftId },
    });

    if (!sendResult.ok) {
      if(sendResult.outcome==='rejected') {
        await sendClient.query(`update agent_actions set status='failed',error_message=$2 where id=$1 and status='executing'`,
          [draft.action_id,sendResult.error]);
      } else {
        // Preserve the executing reservation when delivery is ambiguous. It
        // continues to count against the daily quota until reconciliation.
        await sendClient.query(`update agent_actions set error_message=$2 where id=$1 and status='executing'`,
          [draft.action_id,`awaiting_reconciliation:${sendResult.error}`.slice(0,500)]);
      }
      await sendClient.query('COMMIT');
    } else {
      await sendClient.query(
        `update outreach_drafts set status='sent',sent_at=now(),brevo_message_id=$2 where id=$1`,
        [draftId,sendResult.messageId]);
      await sendClient.query(`update agent_actions set status='executed',executed_at=now() where id=$1`,[draft.action_id]);
      await sendClient.query('COMMIT');
    }
  } catch(error) {
    await sendClient.query('ROLLBACK').catch(()=>undefined);
    await pool.query(`update agent_actions set error_message='awaiting_reconciliation:local_transaction_failure'
      where id=$1 and status='executing'`,[draft.action_id]).catch(()=>undefined);
    throw error;
  } finally { sendClient.release(); }

  if (!sendResult.ok) {
    await logEvent(draft.action_id, 'failed', sendResult.outcome==='unknown'
      ? 'outreach_send_awaiting_reconciliation' : 'outreach_send_failed', {
      draft_id: draftId,
      error: sendResult.error,
      outcome:sendResult.outcome,
    });
    return c.json({ ok: false, error:sendResult.outcome==='unknown'?'send_outcome_unknown':sendResult.error,
      reconciliation_required:sendResult.outcome==='unknown' }, 502);
  }

  await logEvent(draft.action_id, 'executed', 'outreach_sent', {
    draft_id: draftId,
    message_id: sendResult.messageId,
  });

  if (slackConfigured()) {
    await postMessage(`Email envoyé (${draft.to_email}) — message Brevo \`${sendResult.messageId}\``);
  }

  return c.json({ ok: true, message_id: sendResult.messageId });
});

/**
 * Webhook Brevo. Un hard bounce ou une plainte spam supprime l'adresse
 * immediatement — aucune validation humaine n'est requise pour PROTEGER
 * la reputation du domaine (seul l'envoi lui-meme est valide, pas la
 * reaction defensive a un signal negatif).
 */
app.post('/webhook/brevo', async (c) => {
  const secret = process.env.BREVO_WEBHOOK_TOKEN;
  if (!secret) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const provided = c.req.query('token') ?? '';
  if (!constantTimeEqualString(provided, secret)) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const events = await c.req.json().catch(() => null);
  const list = Array.isArray(events) ? events : [events].filter(Boolean);

  let suppressed = 0;

  for (const event of list) {
    const email = event?.email as string | undefined;
    const eventType = event?.event as string | undefined;
    if (!email || !eventType) continue;

    if (eventType === 'hard_bounce') {
      await addSuppression(email,'hard_bounce','brevo_webhook');
      suppressed++;
    } else if (eventType === 'spam') {
      await addSuppression(email,'spam_complaint','brevo_webhook');
      suppressed++;
    } else if (eventType === 'unsubscribed') {
      await addSuppression(email,'unsubscribe','brevo_webhook');
      suppressed++;
    } else if (eventType === 'opened') {
      await pool.query(
        `update outreach_drafts set opened_at = coalesce(opened_at, now())
          where brevo_message_id = $1`,
        [event['message-id'] ?? event.messageId ?? ''],
      );
    }
  }

  if (suppressed > 0) {
    await logEvent(null, 'created', 'suppression_auto_added', { count: suppressed });
  }

  return c.json({ ok: true, processed: list.length, suppressed });
});

const suppressSchema = z.object({
  email: z.string().email(),
  reason: z.enum(['unsubscribe', 'hard_bounce', 'spam_complaint', 'manual']).default('manual'),
});

/** Ajout manuel a la liste de suppression (ex: demande orale, RGPD). */
app.post('/suppression', async (c) => {
  const parsed = suppressSchema.safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
  }

  await addSuppression(parsed.data.email,parsed.data.reason,'manual');

  return c.json({ ok: true });
});

app.get('/suppression', async (c) => {
  const result = await pool.query(
    `select email, reason, source, created_at from suppression_list order by created_at desc limit 200`,
  );
  return c.json({ count: result.rows.length, items: result.rows });
});

/**
 * Ingestion d'une reponse entrante (appelee par le poller Gmail). Classifie
 * sans jamais interpreter le texte comme une instruction — voir
 * core/outreach-guards.ts:classifyReply, purement declaratif (regex).
 */
const inboundSchema = z.object({
  gmail_message_id: z.string().min(1),
  from_address: z.string().email(),
  subject: z.string().optional(),
  body: z.string().min(1),
  draft_id: z.string().uuid().optional(),
});

app.post('/conversations/inbound', async (c) => {
  const parsed = inboundSchema.safeParse(await c.req.json().catch(() => null));

  if (!parsed.success) {
    return c.json({ error: 'invalid_body', details: parsed.error.flatten() }, 400);
  }

  const { gmail_message_id: gmailId, from_address: fromAddress, subject, body, draft_id: draftId } =
    parsed.data;

  const classification = classifyReply(body);

  let leadId: string | null = null;
  if (draftId) {
    const draftResult = await pool.query<{ lead_id: string | null }>(
      `select lead_id from outreach_drafts where id = $1`,
      [draftId],
    );
    leadId = draftResult.rows[0]?.lead_id ?? null;
  }

  const inserted = await pool.query<{ id: string }>(
    `insert into conversations
       (lead_id, draft_id, direction, channel, from_address, subject, body, classification, gmail_message_id)
     values ($1, $2, 'inbound', 'email', $3, $4, $5, $6, $7)
     on conflict (gmail_message_id) do nothing
     returning id`,
    [leadId, draftId ?? null, fromAddress, subject ?? null, body, classification, gmailId],
  );

  if (inserted.rowCount === 0) {
    return c.json({ ok: true, deduplicated: true });
  }

  const conversationId = inserted.rows[0].id;

  if (classification === 'unsubscribe') {
    await addSuppression(fromAddress,'unsubscribe','reply_classified');
  }

  if (slackConfigured()) {
    const label: Record<string, string> = {
      interested: '🟢 Intéressé',
      later: '🟡 Plus tard',
      not_interested: '🔴 Pas intéressé',
      unsubscribe: '⛔ Désabonnement',
      question: '❓ Question',
      unknown: '⚪ Non classé',
    };
    await postMessage(
      `Réponse reçue de ${fromAddress} — ${label[classification] ?? classification}\n` +
        `\`\`\`${body.slice(0, 500)}\`\`\`\n` +
        (classification === 'interested'
          ? '_Signal fort : proposer une mission dev si le besoin est un site/produit._'
          : ''),
    );
  }

  return c.json({ ok: true, conversation_id: conversationId, classification });
});

app.get('/conversations', async (c) => {
  const classification = c.req.query('classification') ?? null;
  const result = await pool.query(
    `select id, created_at, lead_id, from_address, subject, classification
       from conversations
      where direction = 'inbound' and ($1::text is null or classification = $1)
      order by created_at desc
      limit 100`,
    [classification],
  );
  return c.json({ count: result.rows.length, items: result.rows });
});

export default app;
