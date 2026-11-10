import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { normalizeUpstream, resolveDynamicRepository } from '../src/dynamic.js';
import { bearerAuthorized, validateSubscription } from '../src/admin.js';

test('normalizes canonical organization/repository names', () => {
  assert.equal(normalizeUpstream('IBV-IBM/portal'), 'IBV-IBM/portal');
  for (const candidate of [
    '../portal', 'IBV-IBM/../portal', 'IBV-IBM/', '/portal',
    'git@github.ibm.com:IBV-IBM/portal.git', 'IBV-IBM/portal.git',
    'IBV-IBM/portal/extra', 'IBV-IBM/-bad?query', 'IBV-IBM/.hidden'
  ]) {
    assert.throws(() => normalizeUpstream(candidate), { message: /Invalid|must be/ });
  }
});
test('dynamic resolver is restricted to configured organizations', () => {
  const root = path.resolve('/tmp/git-mirror-test-cache');
  const gateway = { sshHost: 'github.ibm.com', allowedOrganizations: ['IBV-IBM'] };
  const repo = resolveDynamicRepository('ibv-ibm/portal', gateway, { cacheDirectory: root });
  assert.equal(repo.url, 'git@github.ibm.com:IBV-IBM/portal.git');
  assert.equal(repo.mirrorPath, path.join(root, 'IBV-IBM', 'portal.git'));
  assert.throws(() => resolveDynamicRepository('OtherOrg/portal', gateway, { cacheDirectory: root }),
    /not allowed/);
  assert.throws(() => resolveDynamicRepository('IBV-IBM/portal', { ...gateway, sshHost: 'github.ibm.com;bad' },
    { cacheDirectory: root }), /Invalid dynamic/);
});
test('administrator bearer token is distinct and requires 24+ characters', () => {
  const token = 'very-long-distinct-admin-token';
  assert.equal(bearerAuthorized('Bearer ' + token, token), true);
  assert.equal(bearerAuthorized('Bearer incorrect', token), false);
  assert.equal(bearerAuthorized('Bearer abc', 'abc'), false);
  assert.equal(bearerAuthorized('', token), false);
});
test('dynamic client subscription uses a controlled mirror root', () => {
  const root = path.resolve('/tmp/git-mirror-replicas');
  const repo = validateSubscription({
    id: 'portal', upstream: 'IBV-IBM/portal', branches: ['staging', 'release/*']
  }, { mirrorRoot: root });
  assert.equal(repo.mirrorPath, path.join(root, 'portal.git'));
  assert.deepEqual(repo.branches, ['staging', 'release/*']);
  assert.throws(() => validateSubscription({
    id: 'portal', upstream: 'IBV-IBM/portal', branches: ['main']
  }, { mirrorRoot: root }, [repo]), /already configured/);
  assert.throws(() => validateSubscription({
    id: '../outside', upstream: 'IBV-IBM/other', branches: ['main']
  }, { mirrorRoot: root }), /valid repository ID/);
});
