import { describe, it, expect } from 'vitest';
import {
  evaluateApproval,
  isApprovable,
  isExpired,
  type ActionState,
} from './approval-rules.js';

const NOW = Date.parse('2026-08-14T18:00:00Z');

function action(overrides: Partial<ActionState> = {}): ActionState {
  return {
    profile: 'agentimpact-dev',
    status: 'approval_requested',
    payload_hash: 'a'.repeat(64),
    approval_expires_at: '2026-08-14T18:15:00Z',
    ...overrides,
  };
}

describe('isApprovable', () => {
  it('accepte les deux seuls statuts ouverts', () => {
    expect(isApprovable('proposed')).toBe(true);
    expect(isApprovable('approval_requested')).toBe(true);
  });

  it('refuse tout statut deja tranche', () => {
    for (const status of ['approved', 'rejected', 'executed', 'failed', 'rolled_back']) {
      expect(isApprovable(status)).toBe(false);
    }
  });
});

describe('isExpired', () => {
  it('une action sans echeance ne peut pas expirer', () => {
    expect(isExpired(null, NOW)).toBe(false);
  });

  it('expire a la seconde exacte, pas une seconde apres', () => {
    expect(isExpired('2026-08-14T18:00:00Z', NOW)).toBe(true);
    expect(isExpired('2026-08-14T18:00:01Z', NOW)).toBe(false);
  });
});

describe('evaluateApproval', () => {
  it('accepte une approbation complete et valide', () => {
    const verdict = evaluateApproval(
      action(),
      { decision: 'approved', approver: 'nadir', payload_hash: 'a'.repeat(64) },
      NOW,
    );
    expect(verdict.allowed).toBe(true);
  });

  it('refuse une approbation sans payload_hash', () => {
    const verdict = evaluateApproval(
      action(),
      { decision: 'approved', approver: 'nadir' },
      NOW,
    );
    expect(verdict).toMatchObject({ allowed: false, reason: 'payload_hash_required', httpStatus: 400 });
  });

  it('refuse un payload_hash qui ne correspond pas', () => {
    const verdict = evaluateApproval(
      action(),
      { decision: 'approved', approver: 'nadir', payload_hash: 'b'.repeat(64) },
      NOW,
    );
    expect(verdict).toMatchObject({ allowed: false, reason: 'payload_hash_mismatch', httpStatus: 409 });
  });

  it("refuse qu'un profil s'approuve lui-meme", () => {
    const verdict = evaluateApproval(
      action(),
      { decision: 'approved', approver: 'agentimpact-dev', payload_hash: 'a'.repeat(64) },
      NOW,
    );
    expect(verdict).toMatchObject({ allowed: false, reason: 'self_approval_forbidden', httpStatus: 403 });
  });

  it("refuse l'auto-approbation meme avec des espaces autour du nom", () => {
    const verdict = evaluateApproval(
      action(),
      { decision: 'approved', approver: '  agentimpact-dev  ', payload_hash: 'a'.repeat(64) },
      NOW,
    );
    expect(verdict).toMatchObject({ allowed: false, reason: 'self_approval_forbidden' });
  });

  it('refuse une action dont la fenetre est passee', () => {
    const verdict = evaluateApproval(
      action({ approval_expires_at: '2026-08-14T17:59:59Z' }),
      { decision: 'approved', approver: 'nadir', payload_hash: 'a'.repeat(64) },
      NOW,
    );
    expect(verdict).toMatchObject({ allowed: false, reason: 'approval_expired', httpStatus: 409 });
  });

  it('refuse une action deja tranchee', () => {
    const verdict = evaluateApproval(
      action({ status: 'approved' }),
      { decision: 'approved', approver: 'nadir', payload_hash: 'a'.repeat(64) },
      NOW,
    );
    expect(verdict).toMatchObject({ allowed: false, reason: 'invalid_status', httpStatus: 409 });
  });

  it('le statut prime sur l expiration : une action tranchee ne renvoie pas "expiree"', () => {
    const verdict = evaluateApproval(
      action({ status: 'executed', approval_expires_at: '2026-08-14T17:00:00Z' }),
      { decision: 'approved', approver: 'nadir', payload_hash: 'a'.repeat(64) },
      NOW,
    );
    expect(verdict).toMatchObject({ reason: 'invalid_status' });
  });

  it('un refus ne demande pas de hash : refuser est toujours sur', () => {
    const verdict = evaluateApproval(
      action(),
      { decision: 'rejected', approver: 'nadir' },
      NOW,
    );
    expect(verdict.allowed).toBe(true);
  });

  it('un refus reste possible par le profil lui-meme', () => {
    const verdict = evaluateApproval(
      action(),
      { decision: 'rejected', approver: 'agentimpact-dev' },
      NOW,
    );
    expect(verdict.allowed).toBe(true);
  });

  it('mais un refus sur une action expiree reste refuse', () => {
    const verdict = evaluateApproval(
      action({ approval_expires_at: '2026-08-14T17:00:00Z' }),
      { decision: 'rejected', approver: 'nadir' },
      NOW,
    );
    expect(verdict).toMatchObject({ allowed: false, reason: 'approval_expired' });
  });
});
