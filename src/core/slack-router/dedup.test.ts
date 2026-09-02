import { describe, expect, it } from 'vitest';
import { createMemoryDedupStore, workspaceEventKey } from './dedup.js';

describe('dedup', () => {
  it('déduplique par team_id:event_id', () => {
    const store = createMemoryDedupStore();
    const key = workspaceEventKey('T1', 'Ev123');
    expect(store.seen(key)).toBe(false);
    store.mark(key);
    expect(store.seen(key)).toBe(true);
  });
});
