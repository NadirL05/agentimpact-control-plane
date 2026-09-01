/**
 * Middleware Bearer — comparaison en temps constant, aucun token dans les logs.
 */

import { timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';
import {
  type AuthScope,
  isRouteAllowed,
  isWebhookExempt,
} from '../core/auth-scopes.js';

export type TokenConfig = Record<AuthScope, string>;

function normalizePath(path: string): string {
  const q = path.indexOf('?');
  return q === -1 ? path : path.slice(0, q);
}

export function constantTimeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
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
  return async (c: Context, next: Next) => {
    const path = normalizePath(c.req.path);
    const method = c.req.method;

    if (isWebhookExempt(method, path)) {
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
