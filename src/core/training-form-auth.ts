/**
 * Validation du token formulaire Training (navigateur, hors Bearer).
 */

import { constantTimeEqualString } from './secure-compare.js';

export function verifyTrainingFormToken(header: string | undefined): boolean {
  const expected = process.env.TRAINING_FORM_TOKEN;
  if (!expected || expected.length === 0) return false;
  if (!header || header.length === 0) return false;
  return constantTimeEqualString(header, expected);
}
