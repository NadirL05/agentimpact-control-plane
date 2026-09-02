import type { SlackRouteDecision, SlackRouteTarget } from './types.js';

const ROUTE_RE = /^ROUTE\s+(GROK|CODEX|ANA)\b\s*:?\s*(.*)$/is;
const DEVIN_EXACT = 'ESCALADE DEVIN';

const TARGET_MAP: Record<string, SlackRouteTarget> = {
  GROK: 'grok',
  CODEX: 'codex',
  ANA: 'ana',
};

/**
 * Détermine la route à partir du texte brut.
 * ESCALADE DEVIN : correspondance exacte (trim), sensible à la casse.
 */
export function parseRoute(text: string): SlackRouteDecision {
  const trimmed = text.trim();

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
