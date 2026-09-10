/**
 * Jarvis feature flags — fail-closed defaults.
 */
import { enabled } from '../model.js';

export type JarvisConfig = {
  enabled: boolean;
  mutationsEnabled: boolean;
};

export function jarvisConfig(env: NodeJS.ProcessEnv = process.env): JarvisConfig {
  return {
    // Requires explicit Jarvis flag; does not inherit V2 business execution.
    enabled: (env.AGENTIMPACT_JARVIS_ENABLED || '0').trim() === '1',
    mutationsEnabled: (env.AGENTIMPACT_JARVIS_MUTATIONS_ENABLED || '0').trim() === '1',
  };
}

/** Optional: Jarvis can be enabled without V2 mission business execution. */
export function jarvisRequiresV2Foundation(env: NodeJS.ProcessEnv = process.env): boolean {
  return enabled(env);
}
