import type { SlackRouteTarget } from './types.js';

export type ThreadOwnerStore = {
  get(threadKey: string): SlackRouteTarget | undefined;
  set(threadKey: string, owner: SlackRouteTarget): void;
};

export function createMemoryThreadOwnerStore(): ThreadOwnerStore {
  const owners = new Map<string, SlackRouteTarget>();

  return {
    get(threadKey: string): SlackRouteTarget | undefined {
      return owners.get(threadKey);
    },
    set(threadKey: string, owner: SlackRouteTarget): void {
      owners.set(threadKey, owner);
    },
  };
}

/**
 * Assigne ou récupère le propriétaire d'un fil.
 * - Fil déjà assigné → propriétaire inchangé (un seul agent par fil).
 * - Nouveau fil racine → assigne `candidate`.
 * - Réponse dans un fil sans propriétaire → refus.
 */
export function resolveThreadOwner(
  store: ThreadOwnerStore,
  threadKey: string,
  candidate: SlackRouteTarget,
  isRootMessage: boolean,
): SlackRouteTarget | 'unowned_thread' {
  const existing = store.get(threadKey);
  if (existing) {
    return existing;
  }
  if (!isRootMessage) {
    return 'unowned_thread';
  }
  store.set(threadKey, candidate);
  return candidate;
}
