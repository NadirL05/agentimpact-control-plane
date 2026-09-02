/**
 * Identité humaine pour les décisions approve/reject — jamais fournie par le client.
 */

import type { AuthScope } from './auth-scopes.js';

export const HUMAN_APPROVER_IDENTITY = 'human-admin';

export function resolveHumanApprover(scope: AuthScope | undefined): string | null {
  if (scope !== 'admin') return null;
  return HUMAN_APPROVER_IDENTITY;
}
