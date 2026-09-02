/**
 * Session navigateur dashboard (cookie signé HttpOnly).
 */

import {
  parseCookieHeader,
  verifySignedSessionToken,
} from './signed-session.js';

export function dashboardSessionSecret(): string | null {
  const secret = process.env.DASHBOARD_ACCESS_TOKEN;
  if (!secret || secret.length === 0) return null;
  return secret;
}

export function hasValidDashboardSession(cookieHeader: string | undefined): boolean {
  const secret = dashboardSessionSecret();
  if (!secret) return false;
  const cookies = parseCookieHeader(cookieHeader);
  return verifySignedSessionToken(cookies.ai_dashboard, 'dashboard', secret);
}
