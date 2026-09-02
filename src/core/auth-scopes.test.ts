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

  it('exempte Brevo, training/log et dashboard avec auth dédiée', () => {
    expect(isBearerExempt('POST', '/api/outreach/webhook/brevo')).toBe(true);
    expect(isBearerExempt('POST', '/api/training/log')).toBe(true);
    expect(isBearerExempt('POST', '/api/training/week')).toBe(false);
    expect(isBearerExempt('POST', '/dashboard/login')).toBe(true);
    expect(isBearerExempt('GET', '/dashboard/login.html')).toBe(true);
  });
});
