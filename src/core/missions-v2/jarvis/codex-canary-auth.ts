/**
 * Root-owned one-shot Codex canary authorization (file-based).
 * Does not depend on outer-verify env passthrough. Never launches providers.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export const CANARY_AUTH_SCOPE = 'ONE_REAL_CODEX_CANARY_ONLY' as const;
export const CANARY_AUTH_DEFAULT_PATH = '/run/agentimpact-jarvis-canary/codex-one-shot.auth';
export const CANARY_AUTH_CONSUMED_DIR = '/var/lib/agentimpact-jarvis-canary/consumed-nonces';

export const canaryAuthObjectSchema = z.object({
  scope: z.literal(CANARY_AUTH_SCOPE),
  script_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  provider: z.literal('codex'),
  max_provider_calls: z.literal(1),
  publisher: z.literal('off'),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  nonce: z.string().uuid(),
}).strict();

export type CanaryAuthObject = z.infer<typeof canaryAuthObjectSchema>;

export type AuthFileStat = Pick<Stats, 'uid' | 'gid' | 'mode' | 'isFile' | 'isDirectory'>;

export type CanaryAuthVerifyInput = {
  authPath: string;
  expectedScriptSha256: string;
  nowMs?: number;
  /** Injected for unit tests (defaults to real fs). */
  readFile?: (path: string) => string;
  stat?: (path: string) => AuthFileStat;
  /** uid that must own the file (default 0 = root). */
  requiredUid?: number;
  requiredGid?: number;
};

export type CanaryAuthVerifyResult =
  | { ok: true; auth: CanaryAuthObject; CANARY_AUTHORIZATION: 'PASS' }
  | { ok: false; CANARY_AUTHORIZATION: 'DENY'; reason: string };

function modeBits(mode: number): number {
  return mode & 0o7777;
}

/** Reject anything group/other readable/writable/executable; require owner-read. */
export function isStrictRootAuthMode(mode: number): boolean {
  const bits = modeBits(mode);
  const ownerRead = (bits & 0o400) !== 0;
  const groupOther = bits & 0o077;
  const ownerWriteExec = bits & 0o300; // write/exec for owner discouraged for auth blob
  return ownerRead && groupOther === 0 && ownerWriteExec === 0;
}

export function verifyCanaryAuthFile(input: CanaryAuthVerifyInput): CanaryAuthVerifyResult {
  const readFile = input.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const stat = input.stat ?? ((p: string) => statSync(p));
  const requiredUid = input.requiredUid ?? 0;
  const requiredGid = input.requiredGid ?? 0;
  const now = input.nowMs ?? Date.now();

  let st: AuthFileStat;
  try {
    st = stat(input.authPath);
  } catch {
    return { ok: false, CANARY_AUTHORIZATION: 'DENY', reason: 'auth_file_missing' };
  }
  if (!st.isFile()) {
    return { ok: false, CANARY_AUTHORIZATION: 'DENY', reason: 'auth_not_regular_file' };
  }
  if (st.uid !== requiredUid || st.gid !== requiredGid) {
    return { ok: false, CANARY_AUTHORIZATION: 'DENY', reason: 'auth_wrong_owner' };
  }
  if (!isStrictRootAuthMode(st.mode)) {
    return { ok: false, CANARY_AUTHORIZATION: 'DENY', reason: 'auth_wrong_mode' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(input.authPath));
  } catch {
    return { ok: false, CANARY_AUTHORIZATION: 'DENY', reason: 'auth_invalid_json' };
  }
  const auth = canaryAuthObjectSchema.safeParse(parsed);
  if (!auth.success) {
    return { ok: false, CANARY_AUTHORIZATION: 'DENY', reason: 'auth_schema_invalid' };
  }
  if (auth.data.scope !== CANARY_AUTH_SCOPE) {
    return { ok: false, CANARY_AUTHORIZATION: 'DENY', reason: 'auth_wrong_scope' };
  }
  if (auth.data.provider !== 'codex') {
    return { ok: false, CANARY_AUTHORIZATION: 'DENY', reason: 'auth_wrong_provider' };
  }
  if (auth.data.max_provider_calls !== 1) {
    return { ok: false, CANARY_AUTHORIZATION: 'DENY', reason: 'auth_max_provider_calls_not_1' };
  }
  if (auth.data.publisher !== 'off') {
    return { ok: false, CANARY_AUTHORIZATION: 'DENY', reason: 'auth_publisher_must_be_off' };
  }
  if (auth.data.script_sha256 !== input.expectedScriptSha256.toLowerCase()) {
    return { ok: false, CANARY_AUTHORIZATION: 'DENY', reason: 'auth_wrong_script_sha' };
  }
  const exp = Date.parse(auth.data.expires_at);
  if (!Number.isFinite(exp) || exp <= now) {
    return { ok: false, CANARY_AUTHORIZATION: 'DENY', reason: 'auth_expired' };
  }
  return { ok: true, auth: auth.data, CANARY_AUTHORIZATION: 'PASS' };
}

export type ConsumeNonceInput = {
  nonce: string;
  consumedDir?: string;
  /** Injected for tests. */
  exists?: (path: string) => boolean;
  mkdir?: (path: string) => void;
  exclusiveCreate?: (path: string, contents: string) => void;
};

export type ConsumeNonceResult =
  | { ok: true; CANARY_AUTHORIZATION_ONE_SHOT: 'PASS'; consumed_path: string }
  | { ok: false; CANARY_AUTHORIZATION_ONE_SHOT: 'DENY'; reason: string };

/**
 * Atomically consume nonce via O_CREAT|O_EXCL semantics.
 * Replay of the same nonce fails.
 */
export function consumeCanaryNonce(input: ConsumeNonceInput): ConsumeNonceResult {
  const dir = input.consumedDir ?? CANARY_AUTH_CONSUMED_DIR;
  const path = join(dir, input.nonce);
  const exists = input.exists ?? existsSync;
  const mkdir = input.mkdir ?? ((p: string) => mkdirSync(p, { recursive: true, mode: 0o700 }));
  const exclusiveCreate = input.exclusiveCreate ?? ((p: string, contents: string) => {
    const fd = openSync(p, 'wx', 0o600);
    try {
      writeFileSync(fd, contents);
    } finally {
      closeSync(fd);
    }
  });

  try {
    mkdir(dir);
  } catch {
    // may already exist
  }
  if (exists(path)) {
    return { ok: false, CANARY_AUTHORIZATION_ONE_SHOT: 'DENY', reason: 'nonce_already_consumed' };
  }
  try {
    exclusiveCreate(path, JSON.stringify({
      nonce: input.nonce,
      consumed_at: new Date().toISOString(),
      scope: CANARY_AUTH_SCOPE,
    }));
  } catch {
    return { ok: false, CANARY_AUTHORIZATION_ONE_SHOT: 'DENY', reason: 'nonce_consume_race_or_replay' };
  }
  return { ok: true, CANARY_AUTHORIZATION_ONE_SHOT: 'PASS', consumed_path: path };
}

export function buildCanaryAuthObject(input: {
  script_sha256: string;
  ttl_seconds?: number;
  now?: Date;
  nonce?: string;
}): CanaryAuthObject {
  const now = input.now ?? new Date();
  const ttl = input.ttl_seconds ?? 900;
  return canaryAuthObjectSchema.parse({
    scope: CANARY_AUTH_SCOPE,
    script_sha256: input.script_sha256.toLowerCase(),
    provider: 'codex',
    max_provider_calls: 1,
    publisher: 'off',
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl * 1000).toISOString(),
    nonce: input.nonce ?? randomUUID(),
  });
}

export function assertAuthParentDir(statFn: (path: string) => AuthFileStat, dirPath: string, requiredUid = 0): { ok: boolean; reason?: string } {
  try {
    const st = statFn(dirPath);
    if (!st.isDirectory()) return { ok: false, reason: 'auth_parent_not_dir' };
    if (st.uid !== requiredUid) return { ok: false, reason: 'auth_parent_wrong_owner' };
    const bits = modeBits(st.mode);
    // root-only: no group/other access
    if ((bits & 0o077) !== 0) return { ok: false, reason: 'auth_parent_not_root_only' };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'auth_parent_missing' };
  }
}

export { dirname };
