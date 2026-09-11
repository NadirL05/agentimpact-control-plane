/**
 * Argv rules for root-authorize-jarvis-v1-2-one-codex-canary-v2.sh
 * (mirrors shell parser; used by static tests).
 *
 * outer-verify-and-run.py always passes exactly one legacy tarball positional.
 * That value must be ignored and must not influence authorization contents.
 */
export const ARMED_CANARY_V2_SHA256 =
  'f3aaa0081634d011e060936ae0517c1d234858626b033f29b635d5fb626c9e60';

export type AuthHelperParseOk = {
  ok: true;
  scriptPath: string | null;
  ttlSeconds: number;
  legacyPositionalCount: number;
  legacyIgnored: boolean;
};

export type AuthHelperParseErr = {
  ok: false;
  reason: 'EXTRA_POSITIONALS' | 'UNKNOWN_FLAG' | 'MISSING_FLAG_VALUE' | 'BAD_TTL';
};

export type AuthHelperParseResult = AuthHelperParseOk | AuthHelperParseErr;

export function parseAuthHelperArgv(
  argv: string[],
  defaults?: { scriptPath?: string; ttlSeconds?: number },
): AuthHelperParseResult {
  let scriptPath: string | null = defaults?.scriptPath ?? null;
  let ttlSeconds = defaults?.ttlSeconds ?? 900;
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--script') {
      const v = argv[++i];
      if (v === undefined) return { ok: false, reason: 'MISSING_FLAG_VALUE' };
      scriptPath = v;
      continue;
    }
    if (a === '--ttl-seconds') {
      const v = argv[++i];
      if (v === undefined) return { ok: false, reason: 'MISSING_FLAG_VALUE' };
      if (!/^\d+$/.test(v)) return { ok: false, reason: 'BAD_TTL' };
      const n = Number(v);
      if (n < 60 || n > 3600) return { ok: false, reason: 'BAD_TTL' };
      ttlSeconds = n;
      continue;
    }
    if (a === '--parse-only') continue;
    if (a.startsWith('--')) return { ok: false, reason: 'UNKNOWN_FLAG' };
    positionals.push(a);
  }

  if (positionals.length > 1) {
    return { ok: false, reason: 'EXTRA_POSITIONALS' };
  }

  return {
    ok: true,
    scriptPath,
    ttlSeconds,
    legacyPositionalCount: positionals.length,
    legacyIgnored: positionals.length === 1,
  };
}

/** Authorization object must never include legacy tarball fields. */
export function authObjectKeysAllowed(obj: Record<string, unknown>): boolean {
  const allowed = new Set([
    'scope',
    'script_sha256',
    'provider',
    'max_provider_calls',
    'publisher',
    'created_at',
    'expires_at',
    'nonce',
  ]);
  return Object.keys(obj).every((k) => allowed.has(k));
}
