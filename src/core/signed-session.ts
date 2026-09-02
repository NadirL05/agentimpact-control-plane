/**
 * Cookies de session signés (HMAC) — secrets côté serveur uniquement.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type SessionKind = 'dashboard' | 'training';

const TTL_SECONDS: Record<SessionKind, number> = {
  dashboard: 8 * 60 * 60,
  training: 30 * 60,
};

export function issueSignedSessionToken(kind: SessionKind, secret: string): string {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS[kind];
  const nonce = randomBytes(16).toString('hex');
  const payload = `${kind}:${exp}:${nonce}`;
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${sig}`;
}

export function verifySignedSessionToken(
  token: string | undefined,
  kind: SessionKind,
  secret: string,
): boolean {
  if (!token || !secret) return false;

  const dot = token.indexOf('.');
  if (dot <= 0) return false;

  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let payload: string;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  } catch {
    return false;
  }

  const expectedSig = createHmac('sha256', secret).update(payload).digest('hex');
  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return false;
  }

  const match = /^([^:]+):(\d+):([a-f0-9]+)$/.exec(payload);
  if (!match || match[1] !== kind) return false;

  const exp = Number(match[2]);
  if (!Number.isInteger(exp) || exp < Math.floor(Date.now() / 1000)) return false;

  return true;
}

export function sessionCookieHeader(
  name: string,
  token: string,
  path: string,
  maxAgeSeconds: number,
): string {
  return `${name}=${token}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${maxAgeSeconds}`;
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) out[key] = value;
  }

  return out;
}
