import type { SlackRouterEnvConfig } from '../config.js';
import { callGrokWorkerSocket } from './grok-socket-client.js';
import { failClosed, type RelayAdapter, type RelayContext, type RelayResult } from './types.js';

export type GrokRelayDeps = {
  config: SlackRouterEnvConfig;
  socketCall?: typeof callGrokWorkerSocket;
};

export function createGrokRelay(deps: GrokRelayDeps): RelayAdapter {
  const callSocket = deps.socketCall ?? callGrokWorkerSocket;

  return {
    target: 'grok',
    async execute(ctx: RelayContext): Promise<RelayResult> {
      const result = await callSocket(deps.config.grokWorkerSocket, ctx.prompt);
      if (!result.ok) {
        return failClosed('grok', result.code, result.message);
      }
      return { ok: true, text: result.text, run_id: result.run_id };
    },
  };
}
