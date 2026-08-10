/**
 * Point d'entree du control plane AgentImpact.
 */

import { getHermesProfiles } from './core/hermes-profiles.js';
import { getPolicies } from './core/policies.js';
import { getWorkflows } from './core/workflows.js';

export function main() {
  console.log('AgentImpact Control Plane — demarrer');

  const profiles = getHermesProfiles();
  console.log(`Profils Hermes charges: ${profiles.length}`);
  for (const p of profiles) {
    console.log(`- ${p.id} (${p.name})`);
  }

  const policies = getPolicies();
  console.log(`\nPolicies chargees: ${policies.length}`);
  for (const p of policies) {
    console.log(`- ${p.id} (${p.name})`);
  }

  const workflows = getWorkflows();
  console.log(`\nWorkflows charges: ${workflows.length}`);
  for (const w of workflows) {
    console.log(`- ${w.id} (${w.name})`);
  }
}

if (import.meta.vitest == null) {
  main();
}
