import { workspaceEventKey, type DedupStore } from './dedup.js';
import { isHumanSlackMessage, threadKey } from './event-filter.js';
import { isGrokKillSwitchActive } from './kill-switch.js';
import { parseRoute } from './parse-route.js';
import type { RateLimitStore } from './rate-limit.js';
import { resolveThreadOwner, type ThreadOwnerStore } from './thread-ownership.js';
import type {
  RouterDispatchResult,
  SlackMessageEvent,
  SlackRouteTarget,
} from './types.js';
import { GROK_DEFAULTS } from './types.js';

export type RouterConfig = {
  nadirUserId: string;
  killSwitchPath?: string;
  /** Sources internes (cron, alertes) — Grok jamais auto sur erreur cron. */
  blockedAutoGrokSources?: Set<string>;
};

export type RouterStores = {
  dedup: DedupStore;
  threadOwners: ThreadOwnerStore;
  grokRateLimit: RateLimitStore;
  /** Mutex mission Grok — max 1 simultanée. */
  grokInFlight: { active: boolean };
};

function isRootMessage(event: SlackMessageEvent): boolean {
  return !event.thread_ts || event.thread_ts === event.ts;
}

export function routeSlackMessage(
  event: SlackMessageEvent,
  stores: RouterStores,
  config: RouterConfig,
): RouterDispatchResult {
  if (!isHumanSlackMessage(event)) {
    return { action: 'ignore', reason: 'not_human_message' };
  }

  const dedupKey = workspaceEventKey(event.team_id, event.event_id);
  if (stores.dedup.seen(dedupKey)) {
    return { action: 'deduplicated', event_id: event.event_id };
  }
  stores.dedup.mark(dedupKey);

  const tKey = threadKey(event);
  const root = isRootMessage(event);
  const parsed = parseRoute(event.text ?? '');

  if (parsed.target === 'devin') {
    if (event.user !== config.nadirUserId) {
      return { action: 'reject', reason: 'devin_nadir_only', thread_key: tKey };
    }
    if ((event.text ?? '').trim() !== 'ESCALADE DEVIN') {
      return { action: 'reject', reason: 'devin_exact_command_required', thread_key: tKey };
    }
  }

  const ownerResult = resolveThreadOwner(
    stores.threadOwners,
    tKey,
    parsed.target,
    root,
  );

  if (ownerResult === 'unowned_thread') {
    return { action: 'ignore', reason: 'thread_unowned' };
  }

  const target: SlackRouteTarget = ownerResult;

  if (target === 'grok') {
    const killPath = config.killSwitchPath ?? GROK_DEFAULTS.killSwitchPath;
    if (isGrokKillSwitchActive(killPath)) {
      return { action: 'reject', reason: 'grok_kill_switch', thread_key: tKey };
    }

    if (event.source && config.blockedAutoGrokSources?.has(event.source)) {
      return { action: 'ignore', reason: 'grok_blocked_auto_source' };
    }

    if (!parsed.explicit && root) {
      return { action: 'ignore', reason: 'grok_requires_explicit_route' };
    }

    if (stores.grokInFlight.active) {
      return { action: 'reject', reason: 'grok_concurrency_limit', thread_key: tKey };
    }

    if (!stores.grokRateLimit.allow(event.user!, event.channel)) {
      return { action: 'reject', reason: 'grok_rate_limited', thread_key: tKey };
    }
  }

  const prompt =
    parsed.prompt ||
    (target === 'devin' ? 'ESCALADE DEVIN' : (event.text ?? '').trim());

  return {
    action: 'delegate',
    target,
    thread_key: tKey,
    prompt,
  };
}
