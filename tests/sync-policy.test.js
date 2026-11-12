import test from 'node:test';
import assert from 'node:assert/strict';
import { syncMode, shouldScheduleSync } from '../src/sync-policy.js';

test('manual mode is the default and does not schedule background fetches', () => {
  assert.equal(syncMode({}), 'manual');
  assert.equal(syncMode({ syncIntervalSeconds: 300 }), 'manual');
  assert.equal(shouldScheduleSync('manual'), false);
  assert.equal(shouldScheduleSync('manual', { recovery: true }), true);
});

test('interval mode must be explicitly opted into', () => {
  assert.equal(syncMode({ syncMode: 'interval' }), 'interval');
  assert.equal(shouldScheduleSync('interval'), true);
  assert.throws(() => syncMode({ syncMode: 'automatic' }), /syncMode/);
});
