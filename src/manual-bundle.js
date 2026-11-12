import { git, validBranch, branchPatterns, matchesBranch, listHeads } from './common.js';

export function validateImportedBranch(repo, branch) {
  if (!validBranch(branch) || !matchesBranch(branch, branchPatterns(repo))) {
    const error = new Error('Branch is not included in this repository subscription');
    error.status = 400;
    throw error;
  }
  return branch;
}

export function validateBundleRefs(output, branch) {
  const refs = output.split('\n').filter(Boolean).map(line => {
    const match = /^([a-f0-9]{40,64}) (refs\/heads\/[A-Za-z0-9_./-]+)$/.exec(line);
    if (!match) throw new Error('Bundle includes an unsupported or invalid reference');
    return match[2];
  });
  if (refs.length !== 1 || refs[0] !== `refs/heads/${branch}`) {
    const error = new Error('Bundle must contain exactly the selected branch (no tags or additional refs)');
    error.status = 400;
    throw error;
  }
}

export async function importManualBundle(repo, filename, branch, { ensureMirror }) {
  validateImportedBranch(repo, branch);
  await ensureMirror(repo);
  await git(['bundle', 'verify', filename], { cwd: repo.mirrorPath, timeout: 600000 });
  const heads = await git(['bundle', 'list-heads', filename], { cwd: repo.mirrorPath });
  validateBundleRefs(heads, branch);
  // Do not force-update existing refs: divergence must be reviewed separately.
  // Atomic fetch avoids partial ref updates if verification or ref updates fail.
  await git(['fetch', '--atomic', filename,
    `refs/heads/${branch}:refs/heads/${branch}`], {
    cwd: repo.mirrorPath, timeout: 600000
  });
  const current = await listHeads(repo.mirrorPath);
  return { [branch]: current[branch] };
}
