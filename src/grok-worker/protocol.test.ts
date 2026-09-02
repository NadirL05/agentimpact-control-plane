import { describe, expect, it } from 'vitest';
import {
  parseGrokWorkerRequest,
  encodeGrokWorkerResponse,
  GROK_WORKER_MAX_REQUEST_BYTES,
} from '../grok-worker/protocol.js';
import { parseWorkerResponseLine } from '../slack-router/relays/grok-socket-client.js';

describe('grok worker protocol', () => {
  it('refuse prompt trop long', () => {
    const req = parseGrokWorkerRequest(
      JSON.stringify({ v: 1, id: 'abc', prompt: 'x'.repeat(GROK_WORKER_MAX_REQUEST_BYTES + 1) }),
    );
    expect(req).toBeNull();
  });

  it('encode réponse newline-terminated', () => {
    const line = encodeGrokWorkerResponse({
      v: 1,
      id: 'id1',
      ok: true,
      text: 'hello',
    });
    expect(line.endsWith('\n')).toBe(true);
    expect(parseWorkerResponseLine(line.trim())?.ok).toBe(true);
  });
});
