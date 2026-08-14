/**
 * Regles de validation humaine (semaine 3), isolees de toute I/O.
 *
 * Ces regles sont la seule chose qui empeche un agent d'ecrire sans accord.
 * Elles sont donc ecrites comme une fonction pure : meme entree, meme verdict,
 * testable sur tous les cas limites sans base ni horloge reelle.
 */

export const APPROVABLE_STATUSES = ['proposed', 'approval_requested'] as const;

export type ApprovalDecision = 'approved' | 'rejected';

export type ActionState = {
  profile: string;
  status: string;
  payload_hash: string;
  approval_expires_at: string | null;
};

export type ApprovalRequest = {
  decision: ApprovalDecision;
  approver: string;
  payload_hash?: string;
};

export type ApprovalVerdict =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | 'invalid_status'
        | 'approval_expired'
        | 'payload_hash_required'
        | 'payload_hash_mismatch'
        | 'self_approval_forbidden';
      httpStatus: 400 | 403 | 409;
    };

export function isApprovable(status: string): boolean {
  return (APPROVABLE_STATUSES as readonly string[]).includes(status);
}

export function isExpired(expiresAt: string | null, now: number): boolean {
  if (expiresAt == null) return false;
  return new Date(expiresAt).getTime() <= now;
}

/**
 * Verdict unique pour une demande de decision.
 *
 * L'ordre des controles compte : un statut invalide prime sur l'expiration,
 * et l'expiration prime sur le hash — sinon une action deja traitee pourrait
 * renvoyer un message d'erreur sur le hash et laisser croire qu'elle est
 * encore ouverte.
 */
export function evaluateApproval(
  action: ActionState,
  request: ApprovalRequest,
  now: number,
): ApprovalVerdict {
  if (!isApprovable(action.status)) {
    return { allowed: false, reason: 'invalid_status', httpStatus: 409 };
  }

  if (isExpired(action.approval_expires_at, now)) {
    return { allowed: false, reason: 'approval_expired', httpStatus: 409 };
  }

  // Un refus n'a pas besoin de porter le hash : refuser est toujours sur.
  if (request.decision === 'rejected') {
    return { allowed: true };
  }

  if (!request.payload_hash) {
    return { allowed: false, reason: 'payload_hash_required', httpStatus: 400 };
  }

  if (request.payload_hash !== action.payload_hash) {
    return { allowed: false, reason: 'payload_hash_mismatch', httpStatus: 409 };
  }

  if (request.approver.trim() === action.profile) {
    return { allowed: false, reason: 'self_approval_forbidden', httpStatus: 403 };
  }

  return { allowed: true };
}
