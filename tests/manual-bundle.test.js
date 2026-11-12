import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git, ensureParent } from '../src/common.js';
import { validateImportedBranch, validateBundleRefs, importManualBundle } from '../src/manual-bundle.js';

test('only configured concrete branch refs can be imported', () => {
  const repo = { id: 'sample', branches: ['main', 'release/*'] };
  assert.equal(validateImportedBranch(repo, 'main'), 'main');
  assert.equal(validateImportedBranch(repo, 'release/v1'), 'release/v1');
  assert.throws(() => validateImportedBranch(repo, 'develop'), /not included/);
  assert.throws(() => validateImportedBranch(repo, '../main'), /not included/);
  validateBundleRefs('a'.repeat(40) + ' refs/heads/main', 'main');
  assert.throws(() => validateBundleRefs('a'.repeat(40) + ' refs/heads/other', 'main'),
    /exactly the selected/);
  assert.throws(() => validateBundleRefs('a'.repeat(40) + ' refs/heads/main\n' +
    'b'.repeat(40) + ' refs/heads/other', 'main'), /exactly the selected/);
  assert.throws(() => validateBundleRefs('a'.repeat(40) + ' refs/tags/v1', 'main'),
    /unsupported/);
});

test('offline bundle can initialize a bare mirror and import a subsequent fast-forward', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'git-mirror-offline-test-'));
  try {
    const source = path.join(root, 'source');
    const mirrorPath = path.join(root, 'replicas', 'sample.git');
    const bundle = path.join(root, 'snapshot.bundle');
    await git(['init', '-b', 'main', source]);
    await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--allow-empty', '-m', 'first'], { cwd: source });
    await git(['bundle', 'create', bundle, 'refs/heads/main'], { cwd: source });
    const repo = { id: 'sample', mirrorPath, branches: ['main'] };
    const ensureMirror = async () => {
      await ensureParent(mirrorPath);
      const initialized = await git(['rev-parse', '--is-bare-repository'], { cwd: mirrorPath })
        .then(() => true, () => false);
      if (!initialized) await git(['init', '--bare', mirrorPath]);
    };
    const first = await importManualBundle(repo, bundle, 'main', { ensureMirror });
    assert.match(first.main, /^[a-f0-9]{40,64}$/);
    await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      'commit', '--allow-empty', '-m', 'second'], { cwd: source });
    await git(['bundle', 'create', bundle, 'refs/heads/main'], { cwd: source });
    const second = await importManualBundle(repo, bundle, 'main', { ensureMirror });
    assert.notEqual(second.main, first.main);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
