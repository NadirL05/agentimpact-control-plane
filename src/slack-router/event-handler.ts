import { createMemoryRateLimitStore } from '../core/slack-router/rate-limit.js';
import type { SlackRouterEnvConfig } from './config.js';
import { dispatchSlackMessage, type DispatchStores } from './dispatch.js';
import { formatSafeLog } from '../core/slack-router/logger.js';
import type { SlackRouteTarget } from '../core/slack-router/types.js';
import type { RouterMetrics } from './metrics.js';
import { recordRouteOutcome } from './metrics.js';
import { createCodexRelay } from './relays/codex-relay.js';
import { createGrokRelay } from './relays/grok-relay.js';
import { createGatewayInboxRelay } from './relays/inbox-relay.js';
import type { RelayAdapter, RelayResult } from './relays/types.js';
import { createPostgresPersistence } from './stores/postgres-persistence.js';
import { createMemoryPersistence, type RouterPersistence } from './stores/persistence.js';
import { getSlackRouterPool } from './stores/pg-pool.js';
import { parseMessageEvent, threadReplyTs, type SlackSocketEnvelope } from './slack-envelope.js';

export type SlackPoster = {
  postThreadReply(channel: string, threadTs: string, text: string): Promise<void>;
};

export type EventHandlerDeps = {
  config: SlackRouterEnvConfig;
  poster: SlackPoster;
  metrics: RouterMetrics;
  logLine: (line: string) => void;
  stores?: DispatchStores;
  relays?: RelayAdapter[];
};

export function createDispatchStores(
  config: SlackRouterEnvConfig,
  persistence?: RouterPersistence,
): DispatchStores {
  return {
    persistence: persistence ?? createPostgresPersistence(),
    grokRateLimit: createMemoryRateLimitStore({
      perUserWindowMs: config.grokRateUserWindowMs,
      perUserMax: config.grokRateUserMax,
      perChannelWindowMs: config.grokRateChannelWindowMs,
      perChannelMax: config.grokRateChannelMax,
    }),
    grokInFlight: { active: false },
  };
}

export function createDefaultRelays(config: SlackRouterEnvConfig): RelayAdapter[] {
  const pool = getSlackRouterPool();
  return [
    createGatewayInboxRelay('hermes', pool),
    createGatewayInboxRelay('ana', pool),
    createCodexRelay(config),
    createGrokRelay({ config }),
  ];
}

function relayForTarget(relays: RelayAdapter[], target: SlackRouteTarget): RelayAdapter | undefined {
  return relays.find((r) => r.target === target);
}

function rejectUserMessage(reason: string): string {
  switch (reason) {
    case 'grok_kill_switch':
      return 'Grokbot est désactivé (kill switch actif).';
    case 'grok_concurrency_limit':
      return 'Grok est déjà en cours sur une autre mission.';
    case 'grok_rate_limited':
      return 'Limite de fréquence Grok atteinte.';
    case 'devin_nadir_only':
      return 'ESCALADE DEVIN réservée à Nadir.';
    case 'devin_not_configured':
      return 'Escalade non configurée.';
    case 'storage_unavailable':
      return 'Routeur indisponible (stockage). Réessayez plus tard.';
    default:
      return 'Commande refusée.';
  }
}

export async function handleSlackEnvelope(
  envelope: SlackSocketEnvelope,
  stores: DispatchStores,
  deps: EventHandlerDeps,
): Promise<void> {
  const started = Date.now();
  deps.metrics.events_received += 1;
  deps.metrics.last_event_at = new Date().toISOString();

  const message = parseMessageEvent(envelope);
  if (!message) return;

  const dispatch = await dispatchSlackMessage(message, stores, {
    nadirUserId: deps.config.nadirUserId,
    nativeAgentUserIds: deps.config.nativeAgentUserIds,
    killSwitchPath: deps.config.killSwitchPath,
    blockedAutoGrokSources: new Set(['cron', 'infra-alert', 'mission-notify']),
  });

  const threadTs = threadReplyTs(message);

  if (dispatch.action === 'deduplicated') {
    deps.metrics.events_deduplicated += 1;
    deps.logLine(
      formatSafeLog({
        event_id: message.event_id,
        thread_ts: threadTs,
        route: 'none',
        status: 'deduplicated',
        duration_ms: Date.now() - started,
      }),
    );
    return;
  }

  if (dispatch.action === 'ignore') {
    deps.metrics.events_ignored += 1;
    deps.logLine(
      formatSafeLog({
        event_id: message.event_id,
        thread_ts: threadTs,
        route: 'none',
        status: `ignored:${dispatch.reason}`,
        duration_ms: Date.now() - started,
      }),
    );
    return;
  }

  if (dispatch.action === 'reject') {
    deps.metrics.events_rejected += 1;
    await deps.poster.postThreadReply(message.channel, threadTs, rejectUserMessage(dispatch.reason));
    deps.logLine(
      formatSafeLog({
        event_id: message.event_id,
        thread_ts: threadTs,
        route: 'none',
        status: `reject:${dispatch.reason}`,
        duration_ms: Date.now() - started,
      }),
    );
    return;
  }

  deps.metrics.events_delegated += 1;
  const relays = deps.relays ?? createDefaultRelays(deps.config);
  const relay = relayForTarget(relays, dispatch.target);
  if (!relay) {
    deps.metrics.events_rejected += 1;
    await deps.poster.postThreadReply(message.channel, threadTs, 'Route interne indisponible.');
    return;
  }

  if (dispatch.target === 'grok') {
    deps.metrics.grok_runs_started += 1;
    stores.grokInFlight.active = true;
  }

  let relayResult: RelayResult;
  try {
    relayResult = await relay.execute({
      prompt: dispatch.prompt,
      channel: message.channel,
      threadTs,
      userId: message.user!,
      eventId: message.event_id,
    });
  } finally {
    if (dispatch.target === 'grok') {
      stores.grokInFlight.active = false;
    }
  }

  const duration = Date.now() - started;

  if (!relayResult.ok) {
    if (dispatch.target === 'grok') deps.metrics.grok_runs_failed += 1;
    else recordRouteOutcome(deps.metrics, dispatch.target, false);
    deps.metrics.events_rejected += 1;
    await deps.poster.postThreadReply(message.channel, threadTs, relayResult.userMessage);
    deps.logLine(
      formatSafeLog({
        event_id: message.event_id,
        thread_ts: threadTs,
        route: dispatch.target,
        status: `relay_fail:${relayResult.code}`,
        duration_ms: duration,
      }),
    );
    return;
  }

  if (dispatch.target !== 'grok') {
    recordRouteOutcome(deps.metrics, dispatch.target, true);
  }
  await deps.poster.postThreadReply(message.channel, threadTs, relayResult.text);
  deps.logLine(
    formatSafeLog({
      event_id: message.event_id,
      thread_ts: threadTs,
      route: dispatch.target,
      status: 'ok',
      duration_ms: duration,
      run_id: relayResult.run_id,
    }),
  );
}

/** Tests : stores mémoire sans Postgres. */
export function createTestDispatchStores(config: SlackRouterEnvConfig): DispatchStores {
  return createDispatchStores(config, createMemoryPersistence());
}
