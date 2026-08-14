import { describe, it, expect } from 'vitest';
import { actionStatusForResult, canDispatch, canRecordResult } from './mission-rules.js';

describe('canDispatch', () => {
  it('autorise une mission pending liee a une action approuvee', () => {
    expect(canDispatch('pending', 'approved')).toEqual({ allowed: true });
  });

  it("refuse tant que l'action n'est pas approuvee, meme si elle est proposee", () => {
    expect(canDispatch('pending', 'proposed')).toMatchObject({
      allowed: false,
      reason: 'action_not_approved',
      httpStatus: 403,
    });
  });

  it("refuse une mission deja en cours : pas de double dispatch", () => {
    expect(canDispatch('in_progress', 'approved')).toMatchObject({
      allowed: false,
      reason: 'mission_not_pending',
      httpStatus: 409,
    });
  });

  it('refuse une mission deja terminee', () => {
    expect(canDispatch('completed', 'approved')).toMatchObject({
      reason: 'mission_not_pending',
    });
  });

  it("le statut de la mission prime : une mission non-pending reste refusee meme si l'action est approuvee", () => {
    const verdict = canDispatch('rejected', 'approved');
    expect(verdict).toMatchObject({ allowed: false, reason: 'mission_not_pending' });
  });
});

describe('canRecordResult', () => {
  it('accepte un resultat pour une mission en cours', () => {
    expect(canRecordResult('in_progress')).toEqual({ allowed: true });
  });

  it('accepte aussi une mission encore pending (agent tres rapide)', () => {
    expect(canRecordResult('pending')).toEqual({ allowed: true });
  });

  it('refuse un resultat sur une mission deja close', () => {
    expect(canRecordResult('completed')).toMatchObject({ reason: 'mission_not_processable' });
    expect(canRecordResult('rejected')).toMatchObject({ reason: 'mission_not_processable' });
    expect(canRecordResult('cancelled')).toMatchObject({ reason: 'mission_not_processable' });
  });
});

describe('actionStatusForResult', () => {
  it('mappe chaque issue de mission vers le statut d action correspondant', () => {
    expect(actionStatusForResult('completed')).toBe('executed');
    expect(actionStatusForResult('failed')).toBe('failed');
    expect(actionStatusForResult('rejected')).toBe('rejected');
  });
});
