/**
 * Point d'entré·¢e du control plane AgentImpact.
 */

import { getHermesProfiles } from './core/hermes-profiles.js';

export function main() {
  console.log('AgentImpact Control Plane — démarrer');

  const profiles = getHermesProfiles();
  console.log(`Profils Hermes charg és: ${profiles.length}`);
  for (const p of profiles) {
    console.log(`- ${p.id} (${p.name})`);
  }
}

if (import.meta.vitest == null) {
  main();
}
