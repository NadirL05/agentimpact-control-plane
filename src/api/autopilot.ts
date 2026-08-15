/**
 * Autopilote : approbation pre-autorisee par politique, sans humain.
 *
 * Appele juste apres la creation d'une action, dans chaque module qui en
 * cree une (growth, drive, github, missions). N'approuve JAMAIS a l'aveugle :
 * relit la politique en base a chaque appel (peut etre desactivee entre deux
 * actions), et le coupe-circuit repasse en manuel des que le taux d'echec ou
 * de refus recent d'une intention depasse le seuil declare.
 *
 * Kill switch immediat : `update policies set enabled = false where
 * policy_key = '<intent>'`. Prend effet a la prochaine action, sans
 * redemarrage.
 */

import { pool } from './db.js';
import { recordDecision, logEvent } from './approvals.js';
import { autopilotApproverName, shouldEngageAutopilot } from '../core/autopilot-rules.js';
import { postMessage, slackConfigured } from './slack.js';

type PolicyRow = {
  policy_key: string;
  enabled: boolean;
  rules: { max_failures_24h?: number; max_rejections_24h?: number };
};

async function loadPolicy(intent: string): Promise<PolicyRow | null> {
  const result = await pool.query<PolicyRow>(
    `select policy_key, enabled, rules from policies where policy_key = $1`,
    [intent],
  );
  return result.rows[0] ?? null;
}

async function loadRecentStats(intent: string): Promise<{ failures24h: number; rejections24h: number }> {
  const failures = await pool.query<{ n: string }>(
    `select count(*)::text as n from agent_actions
      where intent = $1 and status = 'failed' and created_at > now() - interval '24 hours'`,
    [intent],
  );

  const rejections = await pool.query<{ n: string }>(
    `select count(*)::text as n from agent_actions
      where intent = $1 and status = 'rejected'
        and created_at > now() - interval '24 hours'
        and (error_message is null or error_message <> 'approval_expired')`,
    [intent],
  );

  return {
    failures24h: Number(failures.rows[0]?.n ?? 0),
    rejections24h: Number(rejections.rows[0]?.n ?? 0),
  };
}

/**
 * Tente d'approuver automatiquement une action fraichement creee. Ne fait
 * rien (l'action reste `proposed`, attend une decision humaine normale) si
 * aucune politique active ne couvre son intention, ou si le coupe-circuit
 * s'est declenche.
 */
// Invariant de securite, pas une simple convention : ces deux niveaux de
// risque ne passent JAMAIS en autopilote, quelle que soit la politique en
// base. Une politique mal configuree (ou une erreur future) ne peut donc pas
// faire sauter cette limite — il faudrait modifier ce fichier lui-meme.
const AUTOPILOT_ELIGIBLE_RISK_LEVELS = new Set(['read_only', 'reversible_write']);

export async function tryAutopilot(
  actionId: string,
  intent: string,
  payloadHash: string,
  riskLevel: string,
): Promise<{ engaged: boolean; reason?: string }> {
  if (!AUTOPILOT_ELIGIBLE_RISK_LEVELS.has(riskLevel)) {
    return { engaged: false, reason: 'risk_level_ineligible' };
  }

  const policy = await loadPolicy(intent);
  const stats = await loadRecentStats(intent);

  const verdict = shouldEngageAutopilot(
    policy ? { enabled: policy.enabled, maxFailures24h: policy.rules.max_failures_24h ?? 3, maxRejections24h: policy.rules.max_rejections_24h ?? 2 } : null,
    stats,
  );

  if (!verdict.engage) {
    // policy_disabled n'est pas un evenement : c'est l'etat par defaut (pas
    // de politique = manuel), pas la peine de bruiter l'audit pour ca.
    if (verdict.reason !== 'policy_disabled') {
      await logEvent(actionId, 'blocked_by_policy', 'autopilot', {
        stage: 'autopilot_circuit_breaker',
        intent,
        reason: verdict.reason,
        stats,
      });

      if (slackConfigured()) {
        await postMessage(
          `⚠️ Autopilote suspendu pour \`${intent}\` (${verdict.reason}) — repasse en validation manuelle. Action \`${actionId}\` en attente.`,
        );
      }
    }
    return { engaged: false, reason: verdict.reason };
  }

  const approver = autopilotApproverName(policy!.policy_key);
  const result = await recordDecision({
    actionId,
    decision: 'approved',
    approver,
    payloadHash,
    reason: 'autopilot: politique pre-autorisee',
  });

  if (!result.ok) {
    // Verdict refuse pour une autre raison (hash, statut...) : rare ici
    // puisqu'on vient de creer l'action, mais on ne masque jamais un echec.
    await logEvent(actionId, 'blocked_by_policy', 'autopilot', {
      stage: 'autopilot_record_decision_failed',
      intent,
      error: result.error,
    });
    return { engaged: false, reason: result.error };
  }

  return { engaged: true };
}
