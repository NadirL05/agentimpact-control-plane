#!/usr/bin/env node
/**
 * Worker Grok isolé — socket Unix, CURSOR_API_KEY via LoadCredential systemd.
 * Modèle / workspace / mode fixés côté serveur ; concurrence max 1.
 */
import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  encodeGrokWorkerResponse,
  GROK_WORKER_MAX_REQUEST_BYTES,
  parseGrokWorkerRequest,
  type GrokWorkerResponse,
} from './protocol.js';

const SOCKET_PATH =
  process.env.GROK_WORKER_SOCKET?.trim() || '/run/agentimpact-grok-worker/grok.sock';
const WRAPPER =
  process.env.GROK_AGENT_WRAPPER?.trim() || '/opt/agentimpact/scripts/grok-agent-run.sh';
const RUNTIME_DIR =
  process.env.GROK_WORKER_RUNTIME_DIR?.trim() || '/run/agentimpact-grok-worker';
const TIMEOUT_MS = 300_000;

let shuttingDown = false;
let inFlight = false;

function loadCursorApiKey(): string {
  const file = process.env.CURSOR_API_KEY_FILE?.trim();
  if (!file) {
    throw new Error('missing_cursor_api_key_file');
  }
  return readFileSync(file, 'utf8').trim();
}

function extractAssistantText(jsonStdout: string): { text: string; run_id?: string } {
  try {
    const parsed = JSON.parse(jsonStdout) as { result?: string; run_id?: string };
    if (typeof parsed.result === 'string' && parsed.result.trim()) {
      return { text: parsed.result.trim(), run_id: parsed.run_id };
    }
    return { text: 'Réponse Grok vide.', run_id: parsed.run_id };
  } catch {
    return { text: 'Réponse Grok illisible (JSON invalide).' };
  }
}

async function handleLine(line: string, apiKey: string): Promise<string> {
  const req = parseGrokWorkerRequest(line);
  if (!req) {
    return encodeGrokWorkerResponse({
      v: 1,
      id: randomUUID(),
      ok: false,
      code: 'invalid_request',
      message: 'Requête invalide.',
    });
  }

  if (inFlight) {
    return encodeGrokWorkerResponse({
      v: 1,
      id: req.id,
      ok: false,
      code: 'grok_concurrency_limit',
      message: 'Worker Grok occupé.',
    });
  }

  const response = await runGrokPrompt(req.prompt, apiKey, req.id);
  return encodeGrokWorkerResponse({ ...response, id: req.id });
}

async function runGrokPrompt(
  prompt: string,
  apiKey: string,
  requestId: string,
): Promise<GrokWorkerResponse> {
  inFlight = true;
  const promptFile = join(RUNTIME_DIR, `prompt-${requestId}.txt`);

  try {
    writeFileSync(promptFile, prompt, { encoding: 'utf8', mode: 0o600 });

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(WRAPPER, [promptFile], {
        env: {
          ...process.env,
          CURSOR_API_KEY: apiKey,
          HOME: process.env.HOME || '/var/lib/cursor-grok-worker',
          PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
          GROK_AGENT_TIMEOUT_SEC: '300',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let out = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
      child.stderr?.on('data', () => {
        // stderr ignoré — pas de contenu prompt dans les logs
      });

      const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT_MS);
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`grok_exit_${code ?? 'unknown'}`));
          return;
        }
        resolve(out);
      });
      child.on('error', reject);
    });

    const { text, run_id } = extractAssistantText(stdout);
    return { v: 1, id: requestId, ok: true, text, run_id };
  } catch (err) {
    const code = err instanceof Error ? err.message : 'grok_failed';
    return {
      v: 1,
      id: requestId,
      ok: false,
      code,
      message: 'Exécution Grok échouée.',
    };
  } finally {
    inFlight = false;
    try {
      unlinkSync(promptFile);
    } catch {
      // fichier déjà supprimé par le wrapper
    }
  }
}

function startServer(apiKey: string): net.Server {
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > GROK_WORKER_MAX_REQUEST_BYTES * 2) {
        socket.destroy();
        return;
      }
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;
        void handleLine(line, apiKey).then((encoded) => {
          socket.write(encoded);
        });
      }
    });
  });

  const listenFds = Number(process.env.LISTEN_FDS ?? 0);
  if (listenFds >= 1) {
    server.listen({ fd: 3 }, () => {
      process.stdout.write(`grok-worker listening fd=3 socket_activation\n`);
    });
  } else {
    server.listen(SOCKET_PATH, () => {
      process.stdout.write(`grok-worker listening path=${SOCKET_PATH}\n`);
    });
  }

  return server;
}

async function main(): Promise<void> {
  const apiKey = loadCursorApiKey();
  const server = startServer(apiKey);

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : 'startup_failed';
  process.stderr.write(`grok-worker startup error: ${msg}\n`);
  process.exit(1);
});
