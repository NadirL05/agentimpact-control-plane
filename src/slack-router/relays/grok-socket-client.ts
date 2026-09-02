import net from 'node:net';
import { randomUUID } from 'node:crypto';
import type { GrokWorkerResponse } from '../../grok-worker/protocol.js';

export type GrokSocketClientResult =
  | { ok: true; text: string; run_id?: string }
  | { ok: false; code: string; message: string };

export function callGrokWorkerSocket(
  socketPath: string,
  prompt: string,
  timeoutMs = 310_000,
): Promise<GrokSocketClientResult> {
  return new Promise((resolve) => {
    const requestId = randomUUID();
    const payload = JSON.stringify({ v: 1, id: requestId, prompt });

    const socket = net.connect({ path: socketPath });
    let buffer = '';
    let settled = false;

    const finish = (result: GrokSocketClientResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        code: 'grok_socket_timeout',
        message: 'Worker Grok injoignable (timeout).',
      });
    }, timeoutMs);

    socket.on('connect', () => {
      socket.write(`${payload}\n`);
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx < 0) return;

      const line = buffer.slice(0, newlineIdx).trim();
      try {
        const response = JSON.parse(line) as GrokWorkerResponse;
        if (response.ok) {
          finish({ ok: true, text: response.text, run_id: response.run_id });
        } else {
          finish({ ok: false, code: response.code, message: response.message });
        }
      } catch {
        finish({
          ok: false,
          code: 'grok_invalid_response',
          message: 'Réponse worker Grok invalide.',
        });
      }
    });

    socket.on('error', () => {
      finish({
        ok: false,
        code: 'grok_socket_error',
        message: 'Socket worker Grok indisponible.',
      });
    });
  });
}

export function parseWorkerResponseLine(line: string): GrokWorkerResponse | null {
  try {
    return JSON.parse(line) as GrokWorkerResponse;
  } catch {
    return null;
  }
}
