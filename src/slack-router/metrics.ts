export type RouterMetrics = {
  events_received: number;
  events_deduplicated: number;
  events_ignored: number;
  events_rejected: number;
  events_delegated: number;
  grok_runs_started: number;
  grok_runs_failed: number;
  hermes_runs_ok: number;
  hermes_runs_failed: number;
  ana_runs_ok: number;
  ana_runs_failed: number;
  codex_runs_ok: number;
  codex_runs_failed: number;
  socket_reconnects: number;
  last_event_at: string | null;
};

export function createMetrics(): RouterMetrics {
  return {
    events_received: 0,
    events_deduplicated: 0,
    events_ignored: 0,
    events_rejected: 0,
    events_delegated: 0,
    grok_runs_started: 0,
    grok_runs_failed: 0,
    hermes_runs_ok: 0,
    hermes_runs_failed: 0,
    ana_runs_ok: 0,
    ana_runs_failed: 0,
    codex_runs_ok: 0,
    codex_runs_failed: 0,
    socket_reconnects: 0,
    last_event_at: null,
  };
}

export function metricsSnapshot(m: RouterMetrics): RouterMetrics {
  return { ...m };
}

/** Incrémente les compteurs de route (hors Grok, déjà traité à part). */
export function recordRouteOutcome(
  m: RouterMetrics,
  target: string,
  ok: boolean,
): void {
  if (target === 'hermes') {
    if (ok) m.hermes_runs_ok += 1;
    else m.hermes_runs_failed += 1;
    return;
  }
  if (target === 'ana') {
    if (ok) m.ana_runs_ok += 1;
    else m.ana_runs_failed += 1;
    return;
  }
  if (target === 'codex') {
    if (ok) m.codex_runs_ok += 1;
    else m.codex_runs_failed += 1;
  }
}
