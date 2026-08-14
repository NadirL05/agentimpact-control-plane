/**
 * Envoi transactionnel Brevo (semaine 1-2 phase Growth).
 *
 * Aucune route de ce module ne peut composer un message : il envoie
 * uniquement ce qui lui est donne, apres verification de la liste de
 * suppression. La composition et la validation humaine restent dans
 * growth.ts.
 */

const BREVO_API = 'https://api.brevo.com/v3';
const API_KEY = process.env.BREVO_API_KEY;
const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL ?? 'contact@go.agentimpact.fr';
const SENDER_NAME = process.env.BREVO_SENDER_NAME ?? 'Nadir — Agent Impact';
const REPLY_TO = process.env.BREVO_REPLY_TO ?? 'nadir@agentimpact.fr';
const TIMEOUT_MS = 15_000;

export function brevoConfigured(): boolean {
  return Boolean(API_KEY);
}

export type SendResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string };

/**
 * Envoie un email transactionnel unique. L'appelant DOIT avoir verifie la
 * liste de suppression avant d'appeler cette fonction — elle n'a pas acces
 * a la base et ne peut pas le faire elle-meme.
 */
export async function sendTransactional(params: {
  to: string;
  subject: string;
  textContent: string;
  headers?: Record<string, string>;
}): Promise<SendResult> {
  if (!API_KEY) return { ok: false, error: 'missing_brevo_api_key' };

  try {
    const response = await fetch(`${BREVO_API}/smtp/email`, {
      method: 'POST',
      headers: {
        'api-key': API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: SENDER_EMAIL, name: SENDER_NAME },
        to: [{ email: params.to }],
        replyTo: { email: REPLY_TO },
        subject: params.subject,
        textContent: params.textContent,
        headers: params.headers,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const body = (await response.json()) as { messageId?: string; message?: string };

    if (!response.ok || !body.messageId) {
      return { ok: false, error: body.message ?? `brevo_http_${response.status}` };
    }

    return { ok: true, messageId: body.messageId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'brevo_unreachable' };
  }
}

/** Cree le domaine d'envoi et renvoie les enregistrements DNS a poser. */
export async function createSendingDomain(
  domain: string,
): Promise<{ ok: true; records: unknown } | { ok: false; error: string }> {
  if (!API_KEY) return { ok: false, error: 'missing_brevo_api_key' };

  try {
    const response = await fetch(`${BREVO_API}/senders/domains`, {
      method: 'POST',
      headers: { 'api-key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: domain }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const body = await response.json();

    if (!response.ok) {
      return { ok: false, error: (body as { message?: string }).message ?? `http_${response.status}` };
    }

    return { ok: true, records: (body as { dns_records?: unknown }).dns_records };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'brevo_unreachable' };
  }
}

export async function verifySendingDomain(
  domain: string,
): Promise<{ ok: boolean; details: unknown }> {
  if (!API_KEY) return { ok: false, details: 'missing_brevo_api_key' };

  const response = await fetch(
    `${BREVO_API}/senders/domains/${encodeURIComponent(domain)}/authenticate`,
    {
      method: 'PUT',
      headers: { 'api-key': API_KEY },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );

  const body = await response.json();
  return { ok: response.ok, details: body };
}
