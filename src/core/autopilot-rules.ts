/**
 * Regles d'autopilote : quand une action peut s'approuver sans humain.
 *
 * Une politique n'est jamais une approbation en soi — elle declare a l'avance
 * ("j'autorise cette chaine, sous ces conditions") ce qu'un humain ferait
 * pour chaque occurrence. La difference cle avec l'auto-approbation interdite
 * ailleurs (evaluateApproval : approver !== profile) : ici l'approbateur
 * n'est jamais l'agent qui a propose l'action, c'est une regle que Nadir a
 * ecrite avant coup. Le coupe-circuit retire cette autorisation des que le
 * taux d'echec ou de refus recent depasse un seuil — la politique redevient
 * manuelle jusqu'a intervention humaine, sans qu'on ait a y penser.
 */

export type AutopilotPolicy = {
  enabled: boolean;
  maxFailures24h: number;
  maxRejections24h: number;
};

export type RecentStats = {
  failures24h: number;
  rejections24h: number;
};

export type AutopilotVerdict =
  | { engage: true }
  | { engage: false; reason: 'policy_disabled' | 'circuit_breaker_failures' | 'circuit_breaker_rejections' };

export function shouldEngageAutopilot(
  policy: AutopilotPolicy | null,
  stats: RecentStats,
): AutopilotVerdict {
  if (!policy || !policy.enabled) {
    return { engage: false, reason: 'policy_disabled' };
  }

  if (stats.failures24h >= policy.maxFailures24h) {
    return { engage: false, reason: 'circuit_breaker_failures' };
  }

  if (stats.rejections24h >= policy.maxRejections24h) {
    return { engage: false, reason: 'circuit_breaker_rejections' };
  }

  return { engage: true };
}

export function autopilotApproverName(policyKey: string): string {
  return `policy:${policyKey}`;
}
