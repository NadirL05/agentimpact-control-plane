import { describe, expect, it } from 'vitest';
import { buildGrokSpawnSpec, assertNoSecretsInArgv } from './grok-executor.js';

describe('buildGrokSpawnSpec', () => {
  it('utilise le wrapper et positional prompt via fichier (pas stdin)', () => {
    const spec = buildGrokSpawnSpec('question test', {
      wrapperPath: '/opt/agentimpact/scripts/grok-agent-run.sh',
    });
    expect(spec.executable).toBe('/opt/agentimpact/scripts/grok-agent-run.sh');
    expect(spec.promptFilePlaceholder).toBe(true);
    expect(spec.timeoutMs).toBe(300_000);
    expect(spec.env.GROK_AGENT_MODEL).toBe('cursor-grok-4.6-medium');
    expect(() => assertNoSecretsInArgv(spec.args)).not.toThrow();
    expect(spec.env.CURSOR_API_KEY).toBeUndefined();
  });
});
