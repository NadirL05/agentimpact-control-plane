/**
 * Validation session formulaire Training (cookie HttpOnly signé, hors Bearer).
 */

import {
  parseCookieHeader,
  verifySignedSessionToken,
} from './signed-session.js';

export function trainingSessionSecret(): string | null {
  const secret = process.env.TRAINING_FORM_TOKEN;
  if (!secret || secret.length === 0) return null;
  return secret;
}

export function verifyTrainingSessionCookie(cookieHeader: string | undefined): boolean {
  const secret = trainingSessionSecret();
  if (!secret) return false;
  const cookies = parseCookieHeader(cookieHeader);
  return verifySignedSessionToken(cookies.ai_training, 'training', secret);
}

/** @deprecated Utiliser verifyTrainingSessionCookie */
export function verifyTrainingFormToken(header: string | undefined): boolean {
  void header;
  return false;
}
