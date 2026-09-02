import { describe, it, expect } from 'vitest';
import { resolveHumanApprover } from './approval-identity.js';

describe('resolveHumanApprover', () => {
  it('retourne une identité uniquement pour le scope admin', () => {
    expect(resolveHumanApprover('admin')).toBe('human-admin');
    expect(resolveHumanApprover('hermes')).toBeNull();
    expect(resolveHumanApprover('bridge')).toBeNull();
    expect(resolveHumanApprover(undefined)).toBeNull();
  });
});
