// Test-only module: production entrypoints must never import this file.
import { assertV2, type Plan } from '../model.js';
import type { Mission } from '../store.js';
export function fakePlanner(): Plan {
  return {acceptance_criteria:['Fixture passes'],steps:[{title:'Validate fixture',allowed_paths:['fixture.txt']}],
    risks:[],completion_criteria:['Plan persisted'],dependencies:[]};
}
export function fakeWorker(mission: Mission) {
  assertV2(mission);
  return {outcome:'simulated',mission_id:mission.id,provider_calls:0};
}
