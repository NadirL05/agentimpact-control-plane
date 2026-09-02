/**
 * Middleware Bearer — comparaison en temps constant, aucun token dans les logs.
 */

import type { Context, Next } from 'hono';
import {
  type AuthScope,
  isBearerExempt,
  isRouteAllowed,
} from '../core/auth-scopes.js';
import type { AppEnv } from '../core/hono-env.js';
import { constantTimeEqualString } from '../core/secure-compare.js';
import { hasValidDashboardSession } from '../core/dashboard-session.js';

const DASHBOARD_READ_ROUTES: Array<{ method: string; pattern: RegExp }> = [
  { method: 'GET', pattern: /^\/profiles$/ },
  { method: 'GET', pattern: /^\/policies$/ },
  { method: 'GET', pattern: /^\/workflows$/ },
];

function isDashboardReadRoute(method: string, path: string): boolean {
  return DASHBOARD_READ_ROUTES.some(
    (r) => r.method === method.toUpperCase() && r.pattern.test(path),
  );
}

export type TokenConfig = Record<AuthScope, string>;

export { constantTimeEqualString };

function normalizePath(path: string): string {
  const q = path.indexOf('?');
  return q === -1 ? path : path.slice(0, q);
}

export function loadTokenConfig(): TokenConfig {
  const bridge = process.env.CTL_BRIDGE_TOKEN;
  const hermes = process.env.CTL_HERMES_TOKEN;
  const admin = process.env.CTL_ADMIN_TOKEN;

  if (!bridge || !hermes || !admin) {
    throw new Error(
      'CTL_BRIDGE_TOKEN, CTL_HERMES_TOKEN and CTL_ADMIN_TOKEN are required',
    );
  }

  return { bridge, hermes, admin };
}

export function resolveScopeFromToken(
  token: string,
  config: TokenConfig,
): AuthScope | null {
  if (constantTimeEqualString(token, config.admin)) return 'admin';
  if (constantTimeEqualString(token, config.hermes)) return 'hermes';
  if (constantTimeEqualString(token, config.bridge)) return 'bridge';
  return null;
}

function extractBearer(header: string | undefined): string | null {
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

export function createBearerAuthMiddleware(config: TokenConfig) {
  return async (c: Context<AppEnv>, next: Next) => {
    const path = normalizePath(c.req.path);
    const method = c.req.method;

    if (isBearerExempt(method, path)) {
      return next();
    }

    if (
      isDashboardReadRoute(method, path) &&
      hasValidDashboardSession(c.req.header('Cookie'))
    ) {
      c.set('authScope', 'hermes');
      return next();
    }

    const token = extractBearer(c.req.header('Authorization'));
    if (!token) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const scope = resolveScopeFromToken(token, config);
    if (!scope) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    if (!isRouteAllowed(scope, method, path)) {
      return c.json({ error: 'forbidden' }, 403);
    }

    c.set('authScope', scope);
    return next();
  };
}
