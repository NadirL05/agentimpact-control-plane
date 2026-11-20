import test from 'node:test';
import assert from 'node:assert/strict';
import { increment } from '../src/increment.js';

test('increment adds one', () => {
  assert.equal(increment(1), 2);
  assert.equal(increment(41), 42);
});
