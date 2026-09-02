export type RateLimitConfig = {
  perUserWindowMs: number;
  perUserMax: number;
  perChannelWindowMs: number;
  perChannelMax: number;
};

export type RateLimitStore = {
  allow(userId: string, channelId: string, nowMs?: number): boolean;
};

export function createMemoryRateLimitStore(config: RateLimitConfig): RateLimitStore {
  const userHits = new Map<string, number[]>();
  const channelHits = new Map<string, number[]>();

  function prune(key: string, map: Map<string, number[]>, windowMs: number, now: number): number[] {
    const hits = (map.get(key) ?? []).filter((t) => now - t < windowMs);
    map.set(key, hits);
    return hits;
  }

  return {
    allow(userId: string, channelId: string, nowMs = Date.now()): boolean {
      const userList = prune(userId, userHits, config.perUserWindowMs, nowMs);
      const channelList = prune(channelId, channelHits, config.perChannelWindowMs, nowMs);

      if (userList.length >= config.perUserMax) return false;
      if (channelList.length >= config.perChannelMax) return false;

      userList.push(nowMs);
      channelList.push(nowMs);
      userHits.set(userId, userList);
      channelHits.set(channelId, channelList);
      return true;
    },
  };
}
