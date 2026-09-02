import { describe, it, expect, afterEach } from 'vitest';
import { verifyTrainingSessionCookie } from './training-form-auth.js';
import { issueSignedSessionToken, sessionCookieHeader } from './signed-session.js';

describe('verifyTrainingSessionCookie', () => {
  const previous = process.env.TRAINING_FORM_TOKEN;

  afterEach(() => {
    if (previous === undefined) delete process.env.TRAINING_FORM_TOKEN;
    else process.env.TRAINING_FORM_TOKEN = previous;
  });

  it('refuse sans token configuré (fail-closed)', () => {
    delete process.env.TRAINING_FORM_TOKEN;
    expect(verifyTrainingSessionCookie('ai_training=anything')).toBe(false);
  });

  it('accepte un cookie de session valide', () => {
    process.env.TRAINING_FORM_TOKEN = 'training-form-secret-value-32chars';
    const token = issueSignedSessionToken('training', process.env.TRAINING_FORM_TOKEN);
    const header = sessionCookieHeader('ai_training', token, '/api/training', 1800);
    expect(verifyTrainingSessionCookie(header)).toBe(true);
    expect(verifyTrainingSessionCookie('ai_training=invalid')).toBe(false);
  });
});
