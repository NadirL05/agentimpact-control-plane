/**
 * Disposable Codex canary fixture — intentionally failing until increment(n)=n+1.
 * Only src/increment.js may be modified by the agent.
 */
export function brokenIncrementSource(): string {
  return `/** Canary fixture — must return n + 1 after Codex fix. */
export function increment(n) {
  return n;
}
`;
}

export function fixedIncrementSource(): string {
  return `/** Canary fixture — must return n + 1 after Codex fix. */
export function increment(n) {
  return n + 1;
}
`;
}

export function incrementTestSource(): string {
  return `import test from 'node:test';
import assert from 'node:assert/strict';
import { increment } from '../src/increment.js';

test('increment adds one', () => {
  assert.equal(increment(1), 2);
  assert.equal(increment(41), 42);
});
`;
}

export function packageJsonSource(): string {
  return JSON.stringify({ name: 'jarvis-v1-2-codex-canary-fixture', type: 'module', private: true }, null, 2) + '\n';
}
