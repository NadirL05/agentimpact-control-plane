export type DedupStore = {
  seen(eventKey: string): boolean;
  mark(eventKey: string): void;
};

export function workspaceEventKey(teamId: string, eventId: string): string {
  return teamId ? `${teamId}:${eventId}` : eventId;
}

/** Dedup en mémoire avec TTL — suffisant pour les tests et un daemon mono-processus. */
export function createMemoryDedupStore(ttlMs = 86_400_000): DedupStore {
  const entries = new Map<string, number>();

  function purge(now: number): void {
    for (const [key, expiresAt] of entries) {
      if (expiresAt <= now) entries.delete(key);
    }
  }

  return {
    seen(eventKey: string): boolean {
      purge(Date.now());
      return entries.has(eventKey);
    },
    mark(eventKey: string): void {
      entries.set(eventKey, Date.now() + ttlMs);
    },
  };
}
