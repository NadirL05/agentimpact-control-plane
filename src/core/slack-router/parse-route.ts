import type { SlackRouteDecision, SlackRouteTarget } from './types.js';

const ROUTE_RE = /^ROUTE\s+(GROK|CODEX|ANA)\b\s*:?\s*(.*)$/is;
const DEVIN_EXACT = 'ESCALADE DEVIN';
/** Mentions Slack en tête (`<@U…>` / `<@U…|label>`) — souvent le bot routeur. */
const LEADING_MENTIONS_RE = /^(?:<@[UW][A-Z0-9]+(?:\|[^>]*)?>\s+)+/i;

const TARGET_MAP: Record<string, SlackRouteTarget> = {
  GROK: 'grok',
  CODEX: 'codex',
  ANA: 'ana',
};

/** Retire les mentions Slack en tête avant parse (n’altère pas le corps ROUTE). */
export function stripLeadingSlackMentions(text: string): string {
  return text.trim().replace(LEADING_MENTIONS_RE, '').trim();
}

/**
 * Détermine la route à partir du texte brut.
 * ESCALADE DEVIN : correspondance exacte (trim), sensible à la casse.
 * Une mention bot en tête (`<@U…> ROUTE CODEX: …`) est ignorée pour le parse.
 */
export function parseRoute(text: string): SlackRouteDecision {
  const trimmed = stripLeadingSlackMentions(text);

  if (trimmed === DEVIN_EXACT) {
    return { target: 'devin', prompt: '', explicit: true };
  }

  const match = trimmed.match(ROUTE_RE);
  if (match) {
    const keyword = match[1].toUpperCase();
    const target = TARGET_MAP[keyword];
    if (target) {
      return {
        target,
        prompt: (match[2] ?? '').trim(),
        explicit: true,
      };
    }
  }

  return { target: 'hermes', prompt: trimmed, explicit: false };
}
