import { describe, it, expect } from 'vitest';
import {
  issueSignedSessionToken,
  verifySignedSessionToken,
} from './signed-session.js';

describe('signed-session', () => {
  const secret = 'test-secret-value-32-characters-min';

  it('émet et vérifie un token dashboard', () => {
    const token = issueSignedSessionToken('dashboard', secret);
    expect(verifySignedSessionToken(token, 'dashboard', secret)).toBe(true);
    expect(verifySignedSessionToken(token, 'training', secret)).toBe(false);
  });

  it('refuse un token altéré', () => {
    const token = issueSignedSessionToken('training', secret);
    expect(verifySignedSessionToken(`${token}x`, 'training', secret)).toBe(false);
  });
});
