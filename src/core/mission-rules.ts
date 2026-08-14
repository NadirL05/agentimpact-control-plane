/**
 * Regles du bus de missions inter-agents (semaine 3 bis / phase 3).
 *
 * Une mission ne se declenche jamais toute seule : elle suit toujours l'etat
 * de l'action liee (agent_actions). Ce fichier decide QUAND une transition
 * est licite, sans toucher a la base — c'est ce qui la rend testable sur les
 * cas limites (mission deja en cours, action refusee, etc.).
 */

export type MissionStatus = 'pending' | 'in_progress' | 'completed' | 'rejected' | 'cancelled';
export type ActionStatus =
  | 'proposed'
  | 'approval_requested'
  | 'approved'
  | 'rejected'
  | 'executing'
  | 'executed'
  | 'failed'
  | 'rolled_back';

export type MissionVerdict =
  | { allowed: true }
  | { allowed: false; reason: string; httpStatus: 400 | 403 | 404 | 409 };

/**
 * Une mission ne peut etre dispatchee (envoyee a l'agent cible) que si :
 *  - elle est encore `pending` (jamais deux fois la meme mission) ;
 *  - l'action liee est `approved` (jamais sans validation humaine, meme si
 *    `requires_human_validation` etait mis a false par erreur cote appelant).
 */
export function canDispatch(
  missionStatus: MissionStatus,
  actionStatus: ActionStatus,
): MissionVerdict {
  if (missionStatus !== 'pending') {
    return { allowed: false, reason: 'mission_not_pending', httpStatus: 409 };
  }
  if (actionStatus !== 'approved') {
    return { allowed: false, reason: 'action_not_approved', httpStatus: 403 };
  }
  return { allowed: true };
}

/** Une mission ne peut recevoir de resultat que si elle etait en cours. */
export function canRecordResult(missionStatus: MissionStatus): MissionVerdict {
  if (missionStatus !== 'in_progress' && missionStatus !== 'pending') {
    return { allowed: false, reason: 'mission_not_processable', httpStatus: 409 };
  }
  return { allowed: true };
}

const RESULT_TO_ACTION_STATUS: Record<'completed' | 'failed' | 'rejected', ActionStatus> = {
  completed: 'executed',
  failed: 'failed',
  rejected: 'rejected',
};

export function actionStatusForResult(
  resultStatus: 'completed' | 'failed' | 'rejected',
): ActionStatus {
  return RESULT_TO_ACTION_STATUS[resultStatus];
}
