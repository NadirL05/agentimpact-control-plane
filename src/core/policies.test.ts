import { describe, it, expect } from 'vitest';
import { getPolicies } from './policies.js';

describe('getPolicies', () => {
  it('charge les policies sans erreur', () => {
    const policies = getPolicies();
    expect(Array.isArray(policies)).toBe(true);
  });

  it('retourne au moins 4 policies', () => {
    const policies = getPolicies();
    expect(policies.length).toBeGreaterThanOrEqual(4);
  });

  it('contient la policy RBAC', () => {
    const policies = getPolicies();
    const ids = policies.map((p) => p.id);
    expect(ids).toContain('rbac-hermes-profiles');
  });
});
