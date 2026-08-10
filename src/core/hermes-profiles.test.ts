import { describe, it, expect } from 'vitest';
import { getHermesProfiles } from './hermes-profiles.js';

describe('getHermesProfiles', () => {
  it('charge les profils Hermes sans erreur', () => {
    const profiles = getHermesProfiles();
    expect(Array.isArray(profiles)).toBe(true);
  });

  it('retourne exactement 4 profils', () => {
    const profiles = getHermesProfiles();
    expect(profiles).toHaveLength(4);
  });

  it('contient les profils attendus', () => {
    const profiles = getHermesProfiles();
    const ids = profiles.map((p) => p.id);
    expect(ids).toContain('hermes-operator');
    expect(ids).toContain('hermes-auditor');
    expect(ids).toContain('hermes-deployer');
    expect(ids).toContain('hermes-viewer');
  });
});
