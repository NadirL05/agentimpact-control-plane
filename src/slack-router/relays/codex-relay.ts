import type { SlackRouterEnvConfig } from '../config.js';
import { failClosed, type RelayAdapter, type RelayContext, type RelayResult } from './types.js';

async function postJson(url: string, token: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
}

export function createCodexRelay(config: SlackRouterEnvConfig): RelayAdapter {
  return {
    target: 'codex',
    async execute(ctx: RelayContext): Promise<RelayResult> {
      if (!config.bridgeToken) {
        return failClosed(
          'codex',
          'bridge_token_missing',
          'Route Codex indisponible (token bridge non configuré).',
        );
      }

      const title = ctx.prompt.slice(0, 120) || 'Proposition Slack Codex';
      const body = {
        title,
        instruction: ctx.prompt,
        target_agent: 'dev-senior' as const,
        priority: 'normal' as const,
        proposed_by: 'slack-router',
        proposed_by_uid: 0,
        source_url: null,
      };

      let response: Response;
      try {
        response = await postJson(
          `${config.controlPlaneUrl}/api/proposals`,
          config.bridgeToken,
          body,
        );
      } catch {
        return failClosed(
          'codex',
          'codex_unreachable',
          'Control-plane inaccessible — proposition Codex non créée.',
        );
      }

      if (response.status === 201) {
        const data = (await response.json()) as { item?: { id?: string } };
        const id = data.item?.id ?? 'unknown';
        return {
          ok: true,
          text: `Proposition Codex enregistrée (\`${id}\`). Aucun lancement automatique — revue Nadir requise.`,
        };
      }

      return failClosed(
        'codex',
        'codex_http_error',
        `Proposition Codex refusée (HTTP ${response.status}).`,
      );
    },
  };
}
