import { spawn } from 'node:child_process';
import { SupersetParseError } from './json.js';

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type CliRunner = (args: string[], env?: Record<string, string>) => Promise<CliResult>;

export type SupersetCliConfig = {
  /** Absolute path to `superset-cred-run` or `superset` binary. */
  binary: string;
  /** Organization id injected process-only (never logged). */
  organizationId: string;
  /** Extra env (must NOT include SUPERSET_API_KEY plaintext for logging). */
  env?: Record<string, string>;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
};

const SENSITIVE = /sk_live_|sk_test_|SUPERSET_API_KEY|Bearer\s+[A-Za-z0-9._-]+/i;

export function redactSecrets(text: string): string {
  return text.replace(SENSITIVE, '[REDACTED]');
}

export function createSupersetCliRunner(config: SupersetCliConfig): CliRunner {
  const timeoutMs = config.timeoutMs ?? 30_000;
  const maxOut = config.maxStdoutBytes ?? 1_048_576;
  const maxErr = config.maxStderrBytes ?? 262_144;
  if (!config.organizationId || config.organizationId.length < 8) {
    throw new SupersetParseError('invalid_organization_id');
  }
  return (args, extraEnv = {}) => new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/nonexistent',
      CI: '1',
      SUPERSET_ORGANIZATION_ID: config.organizationId,
      ...config.env,
      ...extraEnv,
    };
    // Never accept API key on argv.
    if (args.some((a) => a === '--api-key' || a.startsWith('--api-key='))) {
      reject(new SupersetParseError('api_key_on_argv_forbidden'));
      return;
    }
    const child = spawn(config.binary, args, {
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (buf: Buffer) => {
      outBytes += buf.length;
      if (outBytes <= maxOut) stdout += buf.toString('utf8');
      else child.kill('SIGTERM');
    });
    child.stderr.on('data', (buf: Buffer) => {
      errBytes += buf.length;
      if (errBytes <= maxErr) stderr += buf.toString('utf8');
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout: redactSecrets(stdout),
        stderr: redactSecrets(stderr),
        timedOut,
      });
    });
  });
}

export async function runJsonCommand(
  run: CliRunner,
  args: string[],
): Promise<{ result: CliResult }> {
  const withJson = args.includes('--json') ? args : [...args, '--json'];
  const result = await run(withJson);
  if (result.timedOut) throw new SupersetParseError('timeout');
  return { result };
}
