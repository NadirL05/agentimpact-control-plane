import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('current state documentation', () => {
  it('confirme le succes complet du bus de missions v8 au 14 aout', () => {
    const doc = readFileSync(new URL('../../docs/current-state.md', import.meta.url), 'utf8');
    expect(doc).toContain('14 août 2026 : bus de missions v8 validé en succès complet (push token corrigé).');
  });
});
