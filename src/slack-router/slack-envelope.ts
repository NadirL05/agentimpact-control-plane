import type { SlackMessageEvent } from '../core/slack-router/types.js';

/** Enveloppe Events API Slack (Socket Mode). */
export type SlackSocketEnvelope = {
  envelope_id: string;
  type: 'events_api';
  payload: {
    token?: string;
    team_id: string;
    event_id: string;
    event: Record<string, unknown>;
  };
};

export function isEventsApiEnvelope(raw: unknown): raw is SlackSocketEnvelope {
  if (!raw || typeof raw !== 'object') return false;
  const obj = raw as SlackSocketEnvelope;
  return obj.type === 'events_api' && typeof obj.envelope_id === 'string';
}

export function parseMessageEvent(
  envelope: SlackSocketEnvelope,
): SlackMessageEvent | null {
  const ev = envelope.payload.event;
  if (ev.type !== 'message') return null;

  return {
    type: 'message',
    event_id: envelope.payload.event_id,
    team_id: envelope.payload.team_id,
    channel: String(ev.channel ?? ''),
    user: typeof ev.user === 'string' ? ev.user : undefined,
    text: typeof ev.text === 'string' ? ev.text : undefined,
    ts: String(ev.ts ?? ''),
    thread_ts: typeof ev.thread_ts === 'string' ? ev.thread_ts : undefined,
    bot_id: typeof ev.bot_id === 'string' ? ev.bot_id : undefined,
    subtype: typeof ev.subtype === 'string' ? ev.subtype : undefined,
  };
}

export function threadReplyTs(event: SlackMessageEvent): string {
  return event.thread_ts ?? event.ts;
}
