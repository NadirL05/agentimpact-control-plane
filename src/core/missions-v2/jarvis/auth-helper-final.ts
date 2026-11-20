/**
 * Final auth helper argv + canonical binding rules
 * (root-authorize-jarvis-v1-2-one-codex-canary-final.sh).
 *
 * No --script. No caller TTL. Hardcoded canary path + SHA + TTL=900.
 * outer-verify may pass exactly one ignored legacy positional.
 */
export const ARMED_CANARY_V2_SHA256 =
  'f3aaa0081634d011e060936ae0517c1d234858626b033f29b635d5fb626c9e60';

export const CANONICAL_ARMED_CANARY_PATH =
  '/opt/agentimpact/runner/superset-rpc-bridge/scripts/root-run-jarvis-v1-2-codex-canary-armed-v2.sh';

export const AUTH_HELPER_TTL_SECONDS = 900 as const;

export type FinalAuthHelperParseOk = {
  ok: true;
  legacyPositionalCount: 0 | 1;
  ttlSeconds: typeof AUTH_HELPER_TTL_SECONDS;
  canonicalScriptOnly: true;
};

export type FinalAuthHelperParseErr = {
  ok: false;
  reason: 'EXTRA_POSITIONALS' | 'FLAGS_DENIED';
};

export type FinalAuthHelperParseResult = FinalAuthHelperParseOk | FinalAuthHelperParseErr;

/** Mirror of final helper argv rules: flags denied; 0|1 positional only. */
export function parseFinalAuthHelperArgv(argv: string[]): FinalAuthHelperParseResult {
  const positionals: string[] = [];
  for (const a of argv) {
    if (a.startsWith('-')) {
      return { ok: false, reason: 'FLAGS_DENIED' };
    }
    positionals.push(a);
  }
  if (positionals.length > 1) {
    return { ok: false, reason: 'EXTRA_POSITIONALS' };
  }
  return {
    ok: true,
    legacyPositionalCount: positionals.length as 0 | 1,
    ttlSeconds: AUTH_HELPER_TTL_SECONDS,
    canonicalScriptOnly: true,
  };
}

export function canaryScriptHashBinding(
  actualSha256: string,
  expectedSha256: string = ARMED_CANARY_V2_SHA256,
): 'PASS' | 'FAIL' {
  return actualSha256 === expectedSha256 ? 'PASS' : 'FAIL';
}

/** Live auth JSON must bind only the pinned canary SHA — never argv. */
export function buildFinalAuthObjectFields(input: {
  created_at: string;
  expires_at: string;
  nonce: string;
}): Record<string, unknown> {
  return {
    scope: 'ONE_REAL_CODEX_CANARY_ONLY',
    script_sha256: ARMED_CANARY_V2_SHA256,
    provider: 'codex',
    max_provider_calls: 1,
    publisher: 'off',
    created_at: input.created_at,
    expires_at: input.expires_at,
    nonce: input.nonce,
  };
}
