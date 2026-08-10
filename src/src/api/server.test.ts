import { describe, it, expect } from 'vitest';
import { getHermesProfiles } from '../core/hermes-profiles.js';
import { getPolicies } from '../core/policies.js';
import { getWorkflows } from '../core/workflows.js';

describe('API endpoints (smoke tests)', () => {
  it('profiles endpoint retourne des donnees', () => {
    const profiles = getHermesProfiles();
    expect(profiles.length).toBeGreaterThan(0);
  });

  it('policies endpoint retourne des donnees', () => {
    const policies = getPolicies();
    expect(policies.length).toBeGreaterThan(0);
  });

  it('workflows endpoint retourne des donnees', () => {
    const workflows = getWorkflows();
    expect(workflows.length).toBeGreaterThan(0);
  });
});
