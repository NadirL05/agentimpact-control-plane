/**
 * Comparaison de chaînes en temps constant — partagée par auth, webhooks, formulaires.
 */

import { timingSafeEqual } from 'node:crypto';

export function constantTimeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
