#!/usr/bin/env node
/**
 * In-container / host entrypoint for Jarvis → Superset RPC integration smoke.
 * Flags must remain OFF. No agent.create. No Codex/Cursor provider calls.
 */
import {
  printJarvisIntegrationReport,
  runJarvisSupersetRpcIntegration,
} from '../core/missions-v2/superset/jarvis-integration-smoke.js';

const report = await runJarvisSupersetRpcIntegration(process.env);
const ok = printJarvisIntegrationReport(report);
if (!ok) {
  console.log('JARVIS_INTEGRATION=FAIL');
  process.exit(2);
}
console.log('JARVIS_INTEGRATION=PASS');
process.exit(0);
