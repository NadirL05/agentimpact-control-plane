import { describe, it, expect } from 'vitest';
import {
  constantTimeEqualString,
  resolveScopeFromToken,
  type TokenConfig,
} from '../middleware/auth.js';
import { isRouteAllowed, isWebhookExempt } from '../core/auth-scopes.js';

const config: TokenConfig = {
  bridge: 'bridge-token-value-32chars-minimum!!',
  hermes: 'hermes-token-value-32chars-minimum!!!',
  admin: 'admin-token-value-32chars-minimum!!!!',
};

describe('constantTimeEqualString', () => {
  it('accepte des tokens identiques', () => {
    expect(constantTimeEqualString('abc', 'abc')).toBe(true);
  });

  it('refuse des tokens différents', () => {
    expect(constantTimeEqualString('abc', 'abd')).toBe(false);
  });

  it('refuse des longueurs différentes sans fuite', () => {
    expect(constantTimeEqualString('short', 'much-longer-value')).toBe(false);
  });
});

describe('resolveScopeFromToken', () => {
  it('résout les trois scopes', () => {
    expect(resolveScopeFromToken(config.bridge, config)).toBe('bridge');
    expect(resolveScopeFromToken(config.hermes, config)).toBe('hermes');
    expect(resolveScopeFromToken(config.admin, config)).toBe('admin');
  });

  it('refuse un token inconnu', () => {
    expect(resolveScopeFromToken('unknown-token', config)).toBeNull();
  });
});

describe('auth scopes', () => {
  it('autorise bridge sur health', () => {
    expect(isRouteAllowed('bridge', 'GET', '/health')).toBe(true);
  });

  it('refuse bridge sur dispatch', () => {
    expect(
      isRouteAllowed('bridge', 'POST', '/missions/00000000-0000-0000-0000-000000000001/dispatch'),
    ).toBe(false);
  });

  it('autorise hermes sur dispatch', () => {
    expect(
      isRouteAllowed('hermes', 'POST', '/missions/00000000-0000-0000-0000-000000000001/dispatch'),
    ).toBe(true);
  });

  it('autorise hermes sur autopilot (infra-status-to-vault)', () => {
    expect(isRouteAllowed('hermes', 'GET', '/api/clients/autopilot')).toBe(true);
  });

  it('refuse bridge sur autopilot', () => {
    expect(isRouteAllowed('bridge', 'GET', '/api/clients/autopilot')).toBe(false);
  });

  it('exempte les webhooks signés', () => {
    expect(isWebhookExempt('POST', '/api/github/webhook')).toBe(true);
    expect(isWebhookExempt('GET', '/health')).toBe(false);
  });
});
