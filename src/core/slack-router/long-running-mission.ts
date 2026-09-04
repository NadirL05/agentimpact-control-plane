/**
 * Détection du chemin mission longue (async) vs fast path (sync).
 * Ne décide pas de la route (GROK/ANA/HERMÈS) — uniquement le mode livraison.
 */

export type MissionDeliveryMode = 'sync' | 'async';

export type LongRunningDecision = {
  mode: MissionDeliveryMode;
  missionTitle: string | null;
  reason: string;
};

const EXPLICIT_ASYNC_RE =
  /^(?:ASYNC\s+MISSION|MISSION\s+LONGUE|MISSION\s+ASYNC)\b/im;
const MISSION_NAME_LABEL_RE = /Nom\s+de\s+mission\s*:\s*([A-Za-z0-9][A-Za-z0-9._-]{2,120})/i;
const MISSION_NAME_LINE_RE = /^[A-Z][A-Z0-9][A-Z0-9_-]{4,}(?:-V\d+)?$/m;
const GITHUB_URL_RE = /github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/i;
const AUDIT_HINT_RE =
  /\b(audit|repository|roadmap|dette\s+technique|analyses?\s+le\s+repository|prendre\s+en\s+charge\s+ce\s+projet|mission\s+r[ée]elle)\b/i;

/** Extrait un titre de mission stable pour l’ACK Slack (jamais un secret). */
export function extractMissionTitle(prompt: string): string | null {
  const labeled = prompt.match(MISSION_NAME_LABEL_RE);
  if (labeled?.[1]) return labeled[1].trim().slice(0, 120);

  const line = prompt.match(MISSION_NAME_LINE_RE);
  if (line?.[0]) return line[0].trim().slice(0, 120);

  return null;
}

/**
 * Heuristique conservative : les pings courts et ROUTE GROK/ANA restent sync.
 * Les audits / missions nomméés / prompts longs avec GitHub → async.
 */
export function detectLongRunningMission(prompt: string): LongRunningDecision {
  const text = prompt.trim();
  if (!text) {
    return { mode: 'sync', missionTitle: null, reason: 'empty' };
  }

  const missionTitle = extractMissionTitle(text);

  if (EXPLICIT_ASYNC_RE.test(text)) {
    return {
      mode: 'async',
      missionTitle: missionTitle ?? 'ASYNC-MISSION',
      reason: 'explicit_async',
    };
  }

  if (missionTitle) {
    return { mode: 'async', missionTitle, reason: 'named_mission' };
  }

  if (GITHUB_URL_RE.test(text) && AUDIT_HINT_RE.test(text)) {
    return {
      mode: 'async',
      missionTitle: 'REPO-AUDIT',
      reason: 'github_audit',
    };
  }

  if (text.length >= 800 && /\bmission\b/i.test(text)) {
    return {
      mode: 'async',
      missionTitle: 'LONG-MISSION',
      reason: 'long_mission_prompt',
    };
  }

  return { mode: 'sync', missionTitle: null, reason: 'fast_path' };
}

export function formatAsyncMissionAck(args: {
  missionId: string;
  agent: 'hermes' | 'ana';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
  missionTitle?: string | null;
}): string {
  const title = args.missionTitle?.trim() || 'mission';
  const agentLabel = args.agent === 'ana' ? 'Ana' : 'Hermès';
  return [
    `Mission ${title} enregistrée.`,
    `ID: ${args.missionId}`,
    `Agent: ${agentLabel}`,
    `Statut: ${args.status}`,
  ].join('\n');
}

export function mapInboxStatusToUx(
  status: string,
): 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout' {
  switch (status) {
    case 'pending':
      return 'queued';
    case 'processing':
      return 'running';
    case 'done':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'timeout':
      return 'timeout';
    default:
      return 'failed';
  }
}
