import type { SafeRouterLogEntry } from './types.js';

/** Journalisation sûre : jamais de token, texte utilisateur, ni prompt. */
export function formatSafeLog(entry: SafeRouterLogEntry): string {
  const parts = [
    `event_id=${entry.event_id}`,
    `thread_ts=${entry.thread_ts}`,
    `route=${entry.route}`,
    `status=${entry.status}`,
    `duration_ms=${entry.duration_ms}`,
  ];
  if (entry.run_id) {
    parts.push(`run_id=${entry.run_id}`);
  }
  return parts.join(' ');
}
