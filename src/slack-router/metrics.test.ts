import { describe, expect, it } from 'vitest';
import { createMetrics, recordRouteOutcome } from './metrics.js';

describe('recordRouteOutcome', () => {
  it('incrémente hermes/ana/codex ok et failed', () => {
    const m = createMetrics();
    recordRouteOutcome(m, 'hermes', true);
    recordRouteOutcome(m, 'hermes', false);
    recordRouteOutcome(m, 'ana', true);
    recordRouteOutcome(m, 'codex', false);
    recordRouteOutcome(m, 'grok', true);
    expect(m.hermes_runs_ok).toBe(1);
    expect(m.hermes_runs_failed).toBe(1);
    expect(m.ana_runs_ok).toBe(1);
    expect(m.codex_runs_failed).toBe(1);
    expect(m.grok_runs_started).toBe(0);
  });
});
