import test from 'node:test';
import assert from 'node:assert/strict';
import { gatewayRestarted, expirePending } from '../src/lifecycle.js';

test('detects a new gateway process but ignores same-process MQTT reconnects', () => {
  assert.equal(gatewayRestarted(null, 'boot-a'), false);
  assert.equal(gatewayRestarted('boot-a', 'boot-a'), false);
  assert.equal(gatewayRestarted('boot-a', 'boot-b'), true);
  assert.equal(gatewayRestarted('boot-a', ''), false);
});

test('recovers requests lost when gateway restarts without waiting for timeout', () => {
  const pending = new Map([
    ['req-a', { repo: { id: 'portal' }, created: 100, uploading: false }],
    ['req-b', { repo: { id: 'connections' }, created: 200, uploading: false }]
  ]);
  const expired = expirePending(pending, 250, 30000, { gatewayRestart: true });
  assert.deepEqual(expired, [
    { requestId: 'req-a', repoId: 'portal' },
    { requestId: 'req-b', repoId: 'connections' }
  ]);
  assert.equal(pending.size, 0);
});

test('times out orphaned requests and preserves active uploads', () => {
  const pending = new Map([
    ['stale', { repo: { id: 'portal' }, created: 100, uploading: false }],
    ['recent', { repo: { id: 'connections' }, created: 900, uploading: false }],
    ['upload', { repo: { id: 'reports' }, created: 100, uploading: true }]
  ]);
  assert.deepEqual(expirePending(pending, 1000, 500), [
    { requestId: 'stale', repoId: 'portal' }
  ]);
  assert.deepEqual([...pending.keys()], ['recent', 'upload']);
  assert.deepEqual(expirePending(pending, 1100, 500, { gatewayRestart: true }), [
    { requestId: 'recent', repoId: 'connections' }
  ]);
  assert.deepEqual([...pending.keys()], ['upload']);
});
