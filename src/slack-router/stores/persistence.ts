import { threadKey } from '../../core/slack-router/event-filter.js';
import type { SlackMessageEvent, SlackRouteTarget } from '../../core/slack-router/types.js';

export type PersistencePrepareResult =
  | { status: 'deduplicated' }
  | { status: 'unowned_thread' }
  | { status: 'storage_error' }
  | { status: 'ready'; owner: SlackRouteTarget; thread_key: string };

export type RouterPersistence = {
  prepare(
    event: SlackMessageEvent,
    candidate: SlackRouteTarget,
    isRoot: boolean,
  ): Promise<PersistencePrepareResult>;
  healthcheck(): Promise<boolean>;
};

/** Implémentation mémoire — tests unitaires uniquement. */
export function createMemoryPersistence(): RouterPersistence {
  const dedup = new Set<string>();
  const owners = new Map<string, SlackRouteTarget>();

  return {
    async prepare(event, candidate, isRoot) {
      const dedupKey = `${event.team_id}:${event.event_id}`;
      if (dedup.has(dedupKey)) {
        return { status: 'deduplicated' };
      }
      dedup.add(dedupKey);

      const tKey = threadKey(event);
      const existing = owners.get(tKey);
      if (existing) {
        return { status: 'ready', owner: existing, thread_key: tKey };
      }
      if (!isRoot) {
        return { status: 'unowned_thread' };
      }
      owners.set(tKey, candidate);
      return { status: 'ready', owner: candidate, thread_key: tKey };
    },
    async healthcheck() {
      return true;
    },
  };
}

/** Simule une panne stockage — tests fail-closed. */
export function createFailingPersistence(): RouterPersistence {
  return {
    async prepare() {
      return { status: 'storage_error' };
    },
    async healthcheck() {
      return false;
    },
  };
}
