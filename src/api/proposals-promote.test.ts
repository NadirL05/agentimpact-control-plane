import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const proposalsSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'proposals.ts'),
  'utf-8',
);

describe('proposals promote expiry', () => {
  it('définit approval_expires_at sur les actions promues', () => {
    expect(proposalsSource).toContain('approval_expires_at');
    expect(proposalsSource).toContain("now() + ($7 || ' minutes')::interval");
  });
});
