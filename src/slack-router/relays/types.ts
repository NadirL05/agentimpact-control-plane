import type { SlackRouteTarget } from '../../core/slack-router/types.js';

export type RelayContext = {
  prompt: string;
  channel: string;
  threadTs: string;
  userId: string;
  eventId: string;
};

export type RelayResult =
  | { ok: true; text: string; run_id?: string }
  | { ok: false; code: string; userMessage: string };

export type RelayAdapter = {
  target: SlackRouteTarget;
  execute(ctx: RelayContext): Promise<RelayResult>;
};

export function failClosed(
  target: SlackRouteTarget,
  code: string,
  userMessage: string,
): RelayResult {
  return { ok: false, code, userMessage };
}
