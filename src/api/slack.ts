/**
 * Client Slack minimal (chat.postMessage).
 *
 * Pas de SDK : un seul appel HTTP est necessaire et le conteneur n'a pas
 * besoin d'une dependance de plus. Socket Mode est deja tenu par Hermes ;
 * ouvrir une seconde connexion avec le meme app token ferait du round-robin
 * sur les evenements.
 */

const SLACK_API = 'https://slack.com/api/chat.postMessage';

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const DEFAULT_CHANNEL = process.env.SLACK_HOME_CHANNEL;

const TIMEOUT_MS = 10_000;

export type SlackBlock = Record<string, unknown>;

export type SlackPostResult =
  | { ok: true; ts: string; channel: string }
  | { ok: false; error: string };

export function slackConfigured(): boolean {
  return Boolean(BOT_TOKEN && DEFAULT_CHANNEL);
}

export async function postMessage(
  text: string,
  blocks?: SlackBlock[],
  channel?: string,
): Promise<SlackPostResult> {
  const target = channel ?? DEFAULT_CHANNEL;

  if (!BOT_TOKEN) return { ok: false, error: 'missing_slack_bot_token' };
  if (!target) return { ok: false, error: 'missing_slack_channel' };

  try {
    const response = await fetch(SLACK_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${BOT_TOKEN}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel: target, text, blocks }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const body = (await response.json()) as {
      ok?: boolean;
      ts?: string;
      channel?: string;
      error?: string;
    };

    if (!body.ok || !body.ts) {
      return { ok: false, error: body.error ?? `http_${response.status}` };
    }

    return { ok: true, ts: body.ts, channel: body.channel ?? target };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'slack_unreachable',
    };
  }
}

/** Bloc Slack de rendu d'une action en attente de validation. */
export function approvalBlocks(action: {
  id: string;
  profile: string;
  intent: string;
  risk_level: string;
  dry_run: boolean;
  targets: unknown;
  payload: unknown;
  expires_at: string;
}): SlackBlock[] {
  const targets = Array.isArray(action.targets) ? action.targets : [];
  const payloadPreview = JSON.stringify(action.payload, null, 2).slice(0, 1200);

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Validation demandée', emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Intention*\n${action.intent}` },
        { type: 'mrkdwn', text: `*Profil*\n${action.profile}` },
        { type: 'mrkdwn', text: `*Risque*\n${action.risk_level}` },
        { type: 'mrkdwn', text: `*Dry run*\n${action.dry_run ? 'oui' : 'non'}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Cibles* (${targets.length})\n\`\`\`${JSON.stringify(targets).slice(0, 500)}\`\`\``,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*Payload*\n\`\`\`${payloadPreview}\`\`\`` },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Expire à ${new Date(action.expires_at).toLocaleTimeString('fr-FR')} · répondre \`!approve ${action.id}\` ou \`!reject ${action.id} <raison>\``,
        },
      ],
    },
  ];
}
