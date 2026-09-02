export type RouterMetrics = {
  events_received: number;
  events_deduplicated: number;
  events_ignored: number;
  events_rejected: number;
  events_delegated: number;
  grok_runs_started: number;
  grok_runs_failed: number;
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
    socket_reconnects: 0,
    last_event_at: null,
  };
}

export function metricsSnapshot(m: RouterMetrics): RouterMetrics {
  return { ...m };
}
