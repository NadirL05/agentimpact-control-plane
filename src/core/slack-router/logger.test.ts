import { describe, expect, it } from 'vitest';
import { formatSafeLog } from './logger.js';

describe('formatSafeLog', () => {
  it('ne contient que les champs autorisés', () => {
    const line = formatSafeLog({
      event_id: 'Ev1',
      thread_ts: '123.456',
      route: 'grok',
      status: 'ok',
      duration_ms: 42,
      run_id: 'run-abc',
    });
    expect(line).toContain('event_id=Ev1');
    expect(line).toContain('route=grok');
    expect(line).not.toMatch(/xox[bap]-/);
  });
});
