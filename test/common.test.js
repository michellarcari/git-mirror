import test from 'node:test';
import assert from 'node:assert/strict';
import { validId, validSha } from '../src/common.js';

test('identifiers must be safe for topics and file routing', () => {
  assert.equal(validId('server-a_1'), true);
  assert.equal(validId('server/a'), false);
  assert.equal(validId('../evil'), false);
  assert.equal(validId(''), false);
});

test('Git commit references use full hexadecimal object IDs', () => {
  assert.equal(validSha(null), true);
  assert.equal(validSha('a'.repeat(40)), true);
  assert.equal(validSha('f'.repeat(64)), true);
  assert.equal(validSha('main'), false);
  assert.equal(validSha('Z'.repeat(40)), false);
});
