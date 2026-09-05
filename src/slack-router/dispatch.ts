import { isHumanSlackMessage, threadKey } from '../core/slack-router/event-filter.js';
import { isGrokKillSwitchActive } from '../core/slack-router/kill-switch.js';
import { messageMentionsNativeAgent } from '../core/slack-router/native-agent-mentions.js';
import { parseRoute } from '../core/slack-router/parse-route.js';
import type { RateLimitStore } from '../core/slack-router/rate-limit.js';
import type {
  RouterDispatchResult,
  SlackMessageEvent,
  SlackRouteTarget,
} from '../core/slack-router/types.js';
import { GROK_DEFAULTS } from '../core/slack-router/types.js';
import type { RouterPersistence } from './stores/persistence.js';

export type DispatchConfig = {
  nadirUserId: string;
  nativeAgentUserIds: ReadonlySet<string>;
  killSwitchPath?: string;
  blockedAutoGrokSources?: Set<string>;
};

export type DispatchStores = {
  persistence: RouterPersistence;
  grokRateLimit: RateLimitStore;
  grokInFlight: { active: boolean };
};

function isRootMessage(event: SlackMessageEvent): boolean {
  return !event.thread_ts || event.thread_ts === event.ts;
}

export async function dispatchSlackMessage(
  event: SlackMessageEvent,
  stores: DispatchStores,
  config: DispatchConfig,
): Promise<RouterDispatchResult> {
  if (!isHumanSlackMessage(event)) {
    return { action: 'ignore', reason: 'not_human_message' };
  }

  const root = isRootMessage(event);
  const tKey = threadKey(event);
  const text = event.text ?? '';

  if (root && messageMentionsNativeAgent(text, config.nativeAgentUserIds)) {
    const nativePrep = await stores.persistence.prepare(event, 'native', true);
    if (nativePrep.status === 'deduplicated') {
      return { action: 'deduplicated', event_id: event.event_id };
    }
    if (nativePrep.status === 'storage_error') {
      return { action: 'reject', reason: 'storage_unavailable', thread_key: tKey };
    }
    return { action: 'ignore', reason: 'native_agent_thread' };
  }

  const parsed = parseRoute(text);

  if (parsed.target === 'devin') {
    if (event.user !== config.nadirUserId) {
      return { action: 'reject', reason: 'devin_nadir_only', thread_key: tKey };
    }
    if ((event.text ?? '').trim() !== 'ESCALADE DEVIN') {
      return { action: 'reject', reason: 'devin_exact_command_required', thread_key: tKey };
    }
    return { action: 'reject', reason: 'devin_not_configured', thread_key: tKey };
  }

  const prep = await stores.persistence.prepare(event, parsed.target, root);
  if (prep.status === 'deduplicated') {
    return { action: 'deduplicated', event_id: event.event_id };
  }
  if (prep.status === 'storage_error') {
    return { action: 'reject', reason: 'storage_unavailable', thread_key: tKey };
  }
  if (prep.status === 'v2_thread') return {action:'ignore',reason:'v2_thread_requires_explicit_command'};
  if (prep.status === 'unowned_thread') {
    return { action: 'ignore', reason: 'thread_unowned' };
  }

  if (prep.owner === 'native') {
    return { action: 'ignore', reason: 'native_agent_thread' };
  }

  const target: SlackRouteTarget = prep.owner;

  if (target === 'grok') {
    const killPath = config.killSwitchPath ?? GROK_DEFAULTS.killSwitchPath;
    if (isGrokKillSwitchActive(killPath)) {
      return { action: 'reject', reason: 'grok_kill_switch', thread_key: prep.thread_key };
    }

    if (event.source && config.blockedAutoGrokSources?.has(event.source)) {
      return { action: 'ignore', reason: 'grok_blocked_auto_source' };
    }

    if (!parsed.explicit && root) {
      return { action: 'ignore', reason: 'grok_requires_explicit_route' };
    }

    if (stores.grokInFlight.active) {
      return { action: 'reject', reason: 'grok_concurrency_limit', thread_key: prep.thread_key };
    }

    if (!stores.grokRateLimit.allow(event.user!, event.channel)) {
      return { action: 'reject', reason: 'grok_rate_limited', thread_key: prep.thread_key };
    }
  }

  const prompt = parsed.prompt || (event.text ?? '').trim();

  return {
    action: 'delegate',
    target,
    thread_key: prep.thread_key,
    prompt,
  };
}
