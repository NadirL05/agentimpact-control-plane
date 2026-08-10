/**
 * CLI: liste les registres (profils, policies, workflows).
 */

import { getHermesProfiles } from '../core/hermes-profiles.js';
import { getPolicies } from '../core/policies.js';
import { getWorkflows } from '../core/workflows.js';

function listRegistries() {
  console.log('=== Registre Hermes Profiles ===');
  const profiles = getHermesProfiles();
  for (const p of profiles) {
    console.log(`${p.id} — ${p.name}`);
    console.log(`  ${p.description}`);
    console.log(`  Capabilities: ${p.capabilities.join(', ')}`);
    console.log();
  }

  console.log('=== Registre Policies ===');
  const policies = getPolicies();
  for (const p of policies) {
    console.log(`${p.id} — ${p.name}`);
    console.log(`  ${p.description}`);
    console.log(`  Rules: ${p.rules.join(', ')}`);
    console.log();
  }

  console.log('=== Registre Workflows ===');
  const workflows = getWorkflows();
  for (const w of workflows) {
    console.log(`${w.id} — ${w.name}`);
    console.log(`  ${w.description}`);
    console.log(`  Triggers: ${w.trigger.join(', ')}`);
    console.log(`  Steps: ${w.steps.join(' -> ')}`);
    console.log();
  }
}

listRegistries();
