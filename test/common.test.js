import test from 'node:test';
import assert from 'node:assert/strict';
import { validId, validSha, validBranch, validHeads, branchPatterns, matchesBranch } from '../src/common.js';

test('identifiers and SHAs are validated', () => {
  assert.equal(validId('server-a_1'), true);
  assert.equal(validId('../evil'), false);
  assert.equal(validSha(null), true);
  assert.equal(validSha('a'.repeat(40)), true);
  assert.equal(validSha('main'), false);
});
test('branches can contain slashes but reject invalid refs', () => {
  assert.equal(validBranch('release/2026.11'), true);
  assert.equal(validBranch('feature/sync-client'), true);
  assert.equal(validBranch('../etc'), false);
  assert.equal(validBranch('main.lock'), false);
});
test('single-branch config remains supported', () => {
  assert.deepEqual(branchPatterns({ id: 'repo', branch: 'main' }), ['main']);
});
test('multiple branches and prefix wildcards are supported', () => {
  const patterns = branchPatterns({ id: 'repo', branches: ['main', 'release/*'] });
  assert.equal(matchesBranch('main', patterns), true);
  assert.equal(matchesBranch('release/2026.11', patterns), true);
  assert.equal(matchesBranch('release', patterns), false);
  assert.equal(matchesBranch('develop', patterns), false);
});
test('invalid wildcard expressions are rejected', () => {
  assert.throws(() => branchPatterns({ id: 'repo', branches: ['*'] }));
  assert.throws(() => branchPatterns({ id: 'repo', branches: ['feature/*/fix'] }));
});
test('client heads are validated', () => {
  assert.equal(validHeads({ main: 'a'.repeat(40), 'release/1': null }), true);
  assert.equal(validHeads({ '../bad': 'a'.repeat(40) }), false);
  assert.equal(validHeads({ main: 'HEAD' }), false);
});
