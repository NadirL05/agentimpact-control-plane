import { describe, it, expect, afterEach } from 'vitest';
import { verifyTrainingFormToken } from './training-form-auth.js';

describe('verifyTrainingFormToken', () => {
  const previous = process.env.TRAINING_FORM_TOKEN;

  afterEach(() => {
    if (previous === undefined) delete process.env.TRAINING_FORM_TOKEN;
    else process.env.TRAINING_FORM_TOKEN = previous;
  });

  it('refuse sans token configuré (fail-closed)', () => {
    delete process.env.TRAINING_FORM_TOKEN;
    expect(verifyTrainingFormToken('anything')).toBe(false);
  });

  it('accepte un token valide en temps constant', () => {
    process.env.TRAINING_FORM_TOKEN = 'training-form-secret-value-32chars';
    expect(verifyTrainingFormToken('training-form-secret-value-32chars')).toBe(true);
    expect(verifyTrainingFormToken('wrong')).toBe(false);
  });
});
