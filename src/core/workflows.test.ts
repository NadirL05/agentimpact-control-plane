import { describe, it, expect } from 'vitest';
import { getWorkflows } from './workflows.js';

describe('getWorkflows', () => {
  it('charge les workflows sans erreur', () => {
    const workflows = getWorkflows();
    expect(Array.isArray(workflows)).toBe(true);
  });

  it('retourne exactement 4 workflows', () => {
    const workflows = getWorkflows();
    expect(workflows).toHaveLength(4);
  });

  it('contient le workflow audit', () => {
    const workflows = getWorkflows();
    const ids = workflows.map((w) => w.id);
    expect(ids).toContain('audit');
  });
});
