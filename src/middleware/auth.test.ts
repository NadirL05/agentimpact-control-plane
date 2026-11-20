import { describe, it, expect } from 'vitest';
import {
  constantTimeEqualString,
  loadTokenConfig,
  resolveScopeFromToken,
  type TokenConfig,
} from '../middleware/auth.js';
import { isRouteAllowed, isWebhookExempt } from '../core/auth-scopes.js';

const config: TokenConfig = {
  bridge: 'bridge-token-value-32chars-minimum!!',
  hermes: 'hermes-token-value-32chars-minimum!!!',
  operator: 'operator-token-value-32chars-minimum',
  admin: 'admin-token-value-32chars-minimum!!!!',
  planner: 'planner-token-value-32chars-minimum!!',
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
  it('résout les cinq scopes', () => {
    expect(resolveScopeFromToken(config.bridge, config)).toBe('bridge');
    expect(resolveScopeFromToken(config.hermes, config)).toBe('hermes');
    expect(resolveScopeFromToken(config.operator, config)).toBe('operator');
    expect(resolveScopeFromToken(config.admin, config)).toBe('admin');
    expect(resolveScopeFromToken(config.planner!, config)).toBe('planner');
  });

  it('refuse un token inconnu', () => {
    expect(resolveScopeFromToken('unknown-token', config)).toBeNull();
  });
});

describe('loadTokenConfig', () => {
  it('preserve les trois identites historiques quand operator est absent', () => {
    const keys = ['CTL_BRIDGE_TOKEN','CTL_HERMES_TOKEN','CTL_ADMIN_TOKEN','CTL_OPERATOR_TOKEN','CTL_PLANNER_TOKEN'] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.CTL_BRIDGE_TOKEN=config.bridge;
      process.env.CTL_HERMES_TOKEN=config.hermes;
      process.env.CTL_ADMIN_TOKEN=config.admin;
      delete process.env.CTL_OPERATOR_TOKEN;
      delete process.env.CTL_PLANNER_TOKEN;
      expect(loadTokenConfig()).toEqual({bridge:config.bridge,hermes:config.hermes,admin:config.admin});
    } finally {
      for(const key of keys){const value=previous[key];if(value===undefined)delete process.env[key];else process.env[key]=value;}
    }
  });

  it('refuse un token operator duplique ou trop court', () => {
    const keys = [
      'CTL_BRIDGE_TOKEN',
      'CTL_HERMES_TOKEN',
      'CTL_ADMIN_TOKEN',
      'CTL_OPERATOR_TOKEN',
      'CTL_PLANNER_TOKEN',
    ] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.CTL_BRIDGE_TOKEN = config.bridge;
      process.env.CTL_HERMES_TOKEN = config.hermes;
      process.env.CTL_ADMIN_TOKEN = config.admin;
      process.env.CTL_OPERATOR_TOKEN = config.hermes;
      delete process.env.CTL_PLANNER_TOKEN;
      expect(() => loadTokenConfig()).toThrow(/distinct/);

      process.env.CTL_OPERATOR_TOKEN = 'too-short';
      expect(() => loadTokenConfig()).toThrow(/at least 32/);
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
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

  it('borne operator au nouvel endpoint et a health', () => {
    expect(isRouteAllowed('operator', 'GET', '/health')).toBe(true);
    expect(isRouteAllowed('operator', 'POST', '/api/v2/operator/actions')).toBe(true);
    expect(isRouteAllowed('operator', 'POST', '/api/v2/jarvis/actions')).toBe(false);
    expect(isRouteAllowed('operator', 'POST', '/api/v2/missions')).toBe(false);
    expect(isRouteAllowed('operator', 'POST', '/api/approvals')).toBe(false);
  });

  it('borne planner au transport de plans V2', () => {
    expect(isRouteAllowed('planner','GET','/health')).toBe(true);
    expect(isRouteAllowed('planner','POST','/api/gateway-inbox/claim')).toBe(true);
    expect(isRouteAllowed('planner','POST','/api/v2/missions')).toBe(false);
    expect(isRouteAllowed('planner','POST','/api/fullenrich/enrich')).toBe(false);
  });

  it('exempte les webhooks signés', () => {
    expect(isWebhookExempt('POST', '/api/github/webhook')).toBe(true);
    expect(isWebhookExempt('POST', '/api/outreach/webhook/brevo')).toBe(true);
    expect(isWebhookExempt('GET', '/health')).toBe(false);
  });

  it('refuse hermes sur POST /api/approvals', () => {
    expect(isRouteAllowed('hermes', 'POST', '/api/approvals')).toBe(false);
    expect(isRouteAllowed('admin', 'POST', '/api/approvals')).toBe(true);
  });

  it('retire les anciens chemins GitHub a effets de bord', () => {
    expect(isRouteAllowed('hermes', 'POST', '/api/github/spec')).toBe(true);
    expect(isRouteAllowed('hermes', 'POST', '/api/github/execute')).toBe(false);
    expect(isRouteAllowed('admin', 'POST', '/api/github/review')).toBe(false);
  });
});
