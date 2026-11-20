import { describe, it, expect } from 'vitest';
import { isBearerExempt, isRouteAllowed } from './auth-scopes.js';

describe('auth-scopes second review', () => {
  it('réserve POST /api/approvals au scope admin', () => {
    expect(isRouteAllowed('admin', 'POST', '/api/approvals')).toBe(true);
    expect(isRouteAllowed('hermes', 'POST', '/api/approvals')).toBe(false);
    expect(isRouteAllowed('bridge', 'POST', '/api/approvals')).toBe(false);
  });

  it('autorise exactement GET /api/demos pour hermes', () => {
    expect(isRouteAllowed('hermes', 'GET', '/api/demos')).toBe(true);
    expect(isRouteAllowed('hermes', 'GET', '/api/demos/extra')).toBe(false);
    expect(
      isRouteAllowed('hermes', 'POST', '/api/demos/slug/check-expiry'),
    ).toBe(true);
  });

  it('autorise Jarvis actions pour hermes/admin seulement', () => {
    expect(isRouteAllowed('hermes', 'POST', '/api/v2/jarvis/actions')).toBe(true);
    expect(isRouteAllowed('admin', 'POST', '/api/v2/jarvis/actions')).toBe(true);
    expect(isRouteAllowed('bridge', 'POST', '/api/v2/jarvis/actions')).toBe(false);
  });
});
