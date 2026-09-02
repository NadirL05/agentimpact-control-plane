import { describe, expect, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { readOptionalSecret, readRequiredSecret } from './read-secret-env.js';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
}));

describe('read-secret-env', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(readFileSync).mockReset();
  });

  it('lit depuis fichier LoadCredential', () => {
    vi.stubEnv('PGPASSWORD_FILE', '/run/credentials/pg');
    vi.mocked(readFileSync).mockReturnValue('secret\n');
    expect(readRequiredSecret('PGPASSWORD_FILE', 'postgres_password')).toBe('secret');
  });

  it('fallback variable directe pour tests', () => {
    vi.stubEnv('PGPASSWORD', 'test');
    expect(readRequiredSecret('PGPASSWORD_FILE', 'postgres_password', 'PGPASSWORD')).toBe('test');
  });

  it('secret optionnel vide si absent', () => {
    expect(readOptionalSecret('SLACK_ROUTER_BRIDGE_TOKEN_FILE', 'SLACK_ROUTER_BRIDGE_TOKEN')).toBe(
      '',
    );
  });
});
