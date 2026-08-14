/**
 * Enrichissement FullEnrich : declenchement + webhook de resultat.
 *
 * Portage natif de scripts/enrich-leads-fullenrich.sh : l'API tourne dans un
 * conteneur sans socket Docker, le script (qui fait `docker exec ... psql`) ne
 * peut donc pas etre execute ici. Les requetes SQL sont parametrees.
 */

import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { pool } from './db.js';

const app = new Hono();

const BASE_URL = process.env.FULLENRICH_BASE_URL ?? 'https://app.fullenrich.com/api/v2';
const API_KEY = process.env.FULLENRICH_API_KEY;
const WEBHOOK_URL = process.env.FULLENRICH_WEBHOOK_URL;
const WEBHOOK_TOKEN = process.env.FULLENRICH_WEBHOOK_TOKEN;

const PROFILE = 'agentimpact-growth';
const INTENT = 'fullenrich_enrich';
const REQUEST_TIMEOUT_MS = 20_000;

const enrichSchema = z.object({
  lead_id: z.string().uuid(),
  dry_run: z.boolean().default(false),
});

type LeadRow = {
  id: string;
  contact_name: string | null;
  company_name: string | null;
  website: string | null;
  linkedin_url: string | null;
  fullenrich_status: string | null;
};

function toDomain(website: string | null): string {
  if (!website) return '';
  return website.trim().replace(/^https?:\/\/(www\.)?/i, '').replace(/\/.*$/, '');
}

function splitName(contactName: string | null): { firstName: string; lastName: string } {
  const parts = (contactName ?? '').trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] ?? '', lastName: parts[1] ?? '' };
}

function buildPayload(lead: LeadRow) {
  const { firstName, lastName } = splitName(lead.contact_name);

  return {
    name: `agentimpact-${lead.id}`,
    webhook_url: WEBHOOK_URL,
    webhook_events: { contact_finished: WEBHOOK_URL },
    data: [
      {
        first_name: firstName,
        last_name: lastName,
        domain: toDomain(lead.website),
        company_name: (lead.company_name ?? '').trim(),
        linkedin_url: (lead.linkedin_url ?? '').trim(),
        enrich_fields: [
          'contact.work_emails',
          'contact.personal_emails',
          'contact.phones',
        ],
        custom: { user_id: lead.id },
      },
    ],
  };
}

/**
 * Trace l'action dans agent_actions. Le hash porte un nonce : la contrainte
 * d'unicite sur payload_hash ne doit pas bloquer un reenrichissement legitime.
 */
async function recordAction(
  payload: unknown,
  leadId: string,
  dryRun: boolean,
  status: 'proposed' | 'executing',
): Promise<string> {
  const hashInput = JSON.stringify({ payload, nonce: randomUUID() });
  const payloadHash = createHash('sha256').update(hashInput).digest('hex');

  const result = await pool.query<{ id: string }>(
    `insert into agent_actions
       (profile, intent, targets, payload, payload_hash, risk_level, dry_run, status)
     values ($1, $2, $3::jsonb, $4::jsonb, $5, 'reversible_write', $6, $7)
     returning id`,
    [
      PROFILE,
      INTENT,
      JSON.stringify([leadId]),
      JSON.stringify(payload),
      payloadHash,
      dryRun,
      status,
    ],
  );

  return result.rows[0].id;
}

async function finishAction(
  actionId: string,
  status: 'executed' | 'failed',
  errorMessage?: string,
): Promise<void> {
  await pool.query(
    `update agent_actions
        set status = $2, executed_at = now(), error_message = $3
      where id = $1`,
    [actionId, status, errorMessage ?? null],
  );
}

/** event_type est contraint par agent_audit_events_event_type_check. */
type AuditEventType = 'created' | 'executing' | 'executed' | 'failed';

async function logEvent(
  actionId: string | null,
  eventType: AuditEventType,
  stage: string,
  details: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `insert into agent_audit_events (action_id, event_type, actor, details)
     values ($1, $2, $3, $4::jsonb)`,
    [actionId, eventType, PROFILE, JSON.stringify({ stage, ...details })],
  );
}

app.post('/enrich', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = enrichSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      { success: false, error: 'invalid_body', details: parsed.error.flatten() },
      400,
    );
  }

  const { lead_id: leadId, dry_run: dryRun } = parsed.data;

  const leadResult = await pool.query<LeadRow>(
    `select id, contact_name, company_name, website, linkedin_url, fullenrich_status
       from leads
      where id = $1`,
    [leadId],
  );

  const lead = leadResult.rows[0];

  if (!lead) {
    return c.json({ success: false, error: 'lead_not_found', lead_id: leadId }, 404);
  }

  if (lead.fullenrich_status === 'completed') {
    return c.json({
      success: true,
      skipped: true,
      reason: 'already_enriched',
      lead_id: leadId,
    });
  }

  const { firstName, lastName } = splitName(lead.contact_name);
  const linkedin = (lead.linkedin_url ?? '').trim();

  if (!linkedin && (!firstName || !lastName)) {
    return c.json(
      {
        success: false,
        error: 'insufficient_data',
        message:
          'FullEnrich requires first_name + last_name + domain/company_name, or linkedin_url.',
        lead_id: leadId,
      },
      422,
    );
  }

  if (!WEBHOOK_URL) {
    return c.json({ success: false, error: 'missing_webhook_url_config' }, 503);
  }

  const payload = buildPayload(lead);

  if (dryRun) {
    const actionId = await recordAction(payload, leadId, true, 'proposed');
    return c.json({ success: true, dry_run: true, action_id: actionId, payload });
  }

  if (!API_KEY) {
    return c.json({ success: false, error: 'missing_api_key_config' }, 503);
  }

  const actionId = await recordAction(payload, leadId, false, 'executing');

  await pool.query(
    `update leads
        set fullenrich_status = 'pending',
            fullenrich_started_at = now(),
            fullenrich_error = null
      where id = $1`,
    [leadId],
  );

  let response: Response;
  let raw: string;

  try {
    response = await fetch(`${BASE_URL}/contact/enrich/bulk`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    raw = await response.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'network_error';
    await markLeadFailed(leadId, message);
    await finishAction(actionId, 'failed', message);
    await logEvent(actionId, 'failed', 'fullenrich_request_failed', {
      lead_id: leadId,
      message,
    });
    return c.json({ success: false, error: 'fullenrich_unreachable', message }, 502);
  }

  let parsedResponse: unknown = null;
  try {
    parsedResponse = raw ? JSON.parse(raw) : null;
  } catch {
    parsedResponse = { raw };
  }

  const enrichmentId =
    parsedResponse &&
    typeof parsedResponse === 'object' &&
    'enrichment_id' in parsedResponse &&
    typeof (parsedResponse as { enrichment_id?: unknown }).enrichment_id === 'string'
      ? (parsedResponse as { enrichment_id: string }).enrichment_id
      : null;

  if (!response.ok || !enrichmentId) {
    const message = !response.ok
      ? `fullenrich_http_${response.status}`
      : 'no_enrichment_id';

    await markLeadFailed(leadId, message);
    await finishAction(actionId, 'failed', message);
    await logEvent(actionId, 'failed', 'fullenrich_request_rejected', {
      lead_id: leadId,
      status: response.status,
      response: parsedResponse,
    });

    return c.json(
      {
        success: false,
        error: message,
        status: response.status,
        response: parsedResponse,
      },
      502,
    );
  }

  await pool.query(
    `update leads
        set fullenrich_enrichment_id = $2,
            fullenrich_last_response = $3::jsonb
      where id = $1`,
    [leadId, enrichmentId, JSON.stringify({ enrichment_id: enrichmentId })],
  );

  await finishAction(actionId, 'executed');
  await logEvent(actionId, 'executed', 'fullenrich_requested', {
    lead_id: leadId,
    enrichment_id: enrichmentId,
  });

  return c.json({
    success: true,
    lead_id: leadId,
    enrichment_id: enrichmentId,
    action_id: actionId,
  });
});

async function markLeadFailed(leadId: string, message: string): Promise<void> {
  await pool.query(
    `update leads
        set fullenrich_status = 'failed', fullenrich_error = $2
      where id = $1`,
    [leadId, message],
  );
}

/**
 * Callback FullEnrich (contact_finished). Idempotent : un rejeu ecrase les
 * memes colonnes avec les memes valeurs.
 */
app.post('/webhook', async (c) => {
  if (WEBHOOK_TOKEN) {
    const provided =
      c.req.header('x-webhook-token') ?? c.req.query('token') ?? '';
    if (provided !== WEBHOOK_TOKEN) {
      return c.json({ error: 'unauthorized' }, 401);
    }
  }

  const payload = await c.req.json().catch(() => null);

  if (!payload || typeof payload !== 'object') {
    return c.json({ error: 'invalid_payload' }, 400);
  }

  const envelope = payload as { data?: unknown[]; datas?: unknown[] };
  const first = envelope.data?.[0] ?? envelope.datas?.[0];
  const contact = (first ?? {}) as {
    custom?: { user_id?: unknown };
    contact?: Record<string, unknown>;
  };

  const leadId =
    typeof contact.custom?.user_id === 'string' ? contact.custom.user_id : undefined;

  if (!leadId || !z.string().uuid().safeParse(leadId).success) {
    return c.json({ error: 'missing_user_id' }, 400);
  }

  const contactData = contact.contact ?? {};
  const workEmails = Array.isArray(contactData.work_emails)
    ? contactData.work_emails
    : [];
  const personalEmails = Array.isArray(contactData.personal_emails)
    ? contactData.personal_emails
    : [];
  const phones = Array.isArray(contactData.phones) ? contactData.phones : [];

  const primaryEmail =
    typeof workEmails[0] === 'string'
      ? (workEmails[0] as string)
      : typeof (workEmails[0] as { email?: unknown } | undefined)?.email === 'string'
        ? ((workEmails[0] as { email: string }).email)
        : null;

  const result = await pool.query(
    `update leads
        set fullenrich_status = 'completed',
            fullenrich_completed_at = now(),
            fullenrich_error = null,
            fullenrich_last_response = $2::jsonb,
            email = coalesce(email, $3),
            contact_work_emails = $4::jsonb,
            contact_personal_emails = $5::jsonb,
            contact_phones = $6::jsonb
      where id = $1
      returning id`,
    [
      leadId,
      JSON.stringify(payload),
      primaryEmail,
      JSON.stringify(workEmails),
      JSON.stringify(personalEmails),
      JSON.stringify(phones),
    ],
  );

  if (result.rowCount === 0) {
    return c.json({ error: 'lead_not_found', lead_id: leadId }, 404);
  }

  await logEvent(null, 'executed', 'fullenrich_completed', {
    lead_id: leadId,
    work_emails: workEmails.length,
    personal_emails: personalEmails.length,
    phones: phones.length,
  });

  return c.json({ ok: true, lead_id: leadId });
});

export default app;
