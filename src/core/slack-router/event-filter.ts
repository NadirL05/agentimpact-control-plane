import type { SlackMessageEvent } from './types.js';

const BOT_SUBTYPES = new Set(['bot_message', 'message_changed', 'message_deleted']);

/** Ignore les messages produits par des bots et les sous-types non conversationnels. */
export function isHumanSlackMessage(event: SlackMessageEvent): boolean {
  if (event.bot_id) return false;
  if (event.subtype && BOT_SUBTYPES.has(event.subtype)) return false;
  if (!event.user) return false;
  const text = (event.text ?? '').trim();
  if (!text) return false;
  return true;
}

/** Clé stable d'un fil Slack (racine de thread). */
export function threadKey(event: SlackMessageEvent): string {
  const root = event.thread_ts ?? event.ts;
  return `${event.team_id}:${event.channel}:${root}`;
}
