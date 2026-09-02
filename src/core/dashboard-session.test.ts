import { describe, it, expect, afterEach } from 'vitest';
import { hasValidDashboardSession } from './dashboard-session.js';
import { issueSignedSessionToken, sessionCookieHeader } from './signed-session.js';

describe('dashboard-session', () => {
  const previous = process.env.DASHBOARD_ACCESS_TOKEN;

  afterEach(() => {
    if (previous === undefined) delete process.env.DASHBOARD_ACCESS_TOKEN;
    else process.env.DASHBOARD_ACCESS_TOKEN = previous;
  });

  it('refuse sans token configuré (fail-closed)', () => {
    delete process.env.DASHBOARD_ACCESS_TOKEN;
    expect(hasValidDashboardSession('ai_dashboard=anything')).toBe(false);
  });

  it('accepte un cookie de session valide', () => {
    process.env.DASHBOARD_ACCESS_TOKEN = 'dashboard-access-secret-32chars';
    const token = issueSignedSessionToken('dashboard', process.env.DASHBOARD_ACCESS_TOKEN);
    const header = sessionCookieHeader('ai_dashboard', token, '/', 3600);
    expect(hasValidDashboardSession(header)).toBe(true);
  });
});
