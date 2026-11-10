import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validBranch, validId } from './common.js';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const all = argv.includes('--all');
const configIndex = argv.indexOf('--config');
const repoIndex = argv.indexOf('--repo');
const usage = 'Usage: npm run deploy -- --repo <id> [--apply] [--config path] OR --all [--apply] [--config path]';
if (argv.some((arg, index) => arg !== '--apply' && arg !== '--all' &&
    arg !== '--config' && arg !== '--repo' &&
    !(configIndex >= 0 && index === configIndex + 1) &&
    !(repoIndex >= 0 && index === repoIndex + 1)) ||
    (configIndex !== -1 && !argv[configIndex + 1]) ||
    (repoIndex !== -1 && !argv[repoIndex + 1]) ||
    (all && repoIndex !== -1) ||
    argv.filter(arg => arg === '--apply').length > 1 ||
    argv.filter(arg => arg === '--all').length > 1 ||
    argv.filter(arg => arg === '--config').length > 1 ||
    argv.filter(arg => arg === '--repo').length > 1) throw new Error(usage);

const configPath = path.resolve(configIndex < 0
  ? (process.env.DEPLOY_CONFIG || 'config/deploy.json') : argv[configIndex + 1]);
const source = JSON.parse(await readFile(configPath, 'utf8'));
const repositories = source.repositories ??
  (source.checkoutPath ? [{ id: 'default', ...source }] : []);
if (!Array.isArray(repositories) || repositories.length === 0 ||
    repositories.some(repo => !validId(repo.id)) ||
    new Set(repositories.map(repo => repo.id)).size !== repositories.length) {
  throw new Error('Deploy configuration requires unique repository IDs');
}
if (!all && repoIndex < 0 && repositories.length !== 1) throw new Error(usage);
const selectedId = repoIndex >= 0 ? argv[repoIndex + 1] : repositories[0].id;
if (!all && !validId(selectedId)) throw new Error(usage);

if (all) {
  let failed = false;
  const script = fileURLToPath(import.meta.url);
  for (const repo of repositories) {
    console.log(JSON.stringify({ event: 'deploy.repository_started', repoId: repo.id }));
    try {
      await new Promise((resolve, reject) => {
        const args = [script, '--config', configPath, '--repo', repo.id, ...(apply ? ['--apply'] : [])];
        const child = spawn(process.execPath, args, { stdio: 'inherit', shell: false, windowsHide: true });
        child.once('error', reject);
        child.once('exit', (code, signal) => code === 0 ? resolve() :
          reject(new Error(`Deploy failed for ${repo.id} (exit ${code}, signal ${signal || 'none'})`)));
      });
    } catch (error) {
      failed = true;
      console.error(JSON.stringify({ event: 'deploy.repository_failed', repoId: repo.id, error: error.message }));
    }
  }
  if (failed) process.exitCode = 1;
} else {
  const config = repositories.find(repo => repo.id === selectedId);
  if (!config) throw new Error(`Unknown deployment repository: ${selectedId}`);
  const { checkoutPath, mirrorPath, branch, prepareCommands, testCommands } = config;
  if (!path.isAbsolute(checkoutPath) || !path.isAbsolute(mirrorPath) || !validBranch(branch) ||
      !Array.isArray(testCommands) || !testCommands.length) {
    throw new Error(`Invalid deploy config for ${selectedId}: expected absolute paths, branch, and testCommands`);
  }
  for (const commands of [prepareCommands || [], testCommands]) {
    if (!Array.isArray(commands) || !commands.every(command =>
      Array.isArray(command) && command.length &&
      command.every(word => typeof word === 'string' && word.length))) {
      throw new Error(`Invalid commands for ${selectedId}; use argv arrays without shell`);
    }
  }
  await deploy(config);
}

async function run(program, commandArgs, cwd, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, commandArgs, {
      cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' }
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-12000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${program} ${commandArgs[0] || ''} failed (exit ${code}): ${stderr || stdout}`));
    });
  });
}
async function deploy(config) {
  const { id: repoId, checkoutPath, mirrorPath, branch, prepareCommands, testCommands } = config;
const git = (commandArgs, cwd = checkoutPath) => run('git', commandArgs, cwd);
const ref = `refs/heads/${branch}`;
const tracking = `refs/remotes/mirror/${branch}`;
const workspace = await mkdtemp(path.join(tmpdir(), 'git-mirror-deploy-'));
const candidate = path.join(workspace, 'candidate');
let worktreeAdded = false;

try {
  if ((await git(['rev-parse', '--show-toplevel'])) !== checkoutPath ||
      (await git(['symbolic-ref', '--quiet', '--short', 'HEAD'])) !== branch) {
    throw new Error(`Checkout must be at ${checkoutPath} with ${branch} checked out`);
  }
  if (await git(['status', '--porcelain', '--untracked-files=normal'])) {
    throw new Error('Checkout has uncommitted or untracked changes; deployment refused');
  }
  if ((await git(['rev-parse', '--is-bare-repository'], mirrorPath)) !== 'true') {
    throw new Error('Configured mirrorPath is not a bare Git repository');
  }
  const configuredMirror = await git(['remote', 'get-url', 'mirror']);
  if (path.resolve(configuredMirror) !== path.resolve(mirrorPath)) {
    throw new Error('The mirror remote does not match configured mirrorPath');
  }
  const previous = await git(['rev-parse', ref]);
  await git(['fetch', '--no-tags', mirrorPath, `+refs/heads/${branch}:${tracking}`]);
  const upstream = await git(['rev-parse', tracking]);
  console.log(JSON.stringify({ event: 'deploy.prepared', repoId, branch, previous, upstream, apply }));
  if (await git(['merge-base', '--is-ancestor', upstream, previous]).then(() => true, () => false)) {
    console.log(JSON.stringify({ event: 'deploy.unchanged', repoId, branch, previous }));
    process.exitCode = 0;
  } else {
    await git(['worktree', 'add', '--detach', candidate, previous]);
    worktreeAdded = true;
    try {
      await git(['-c', 'user.name=Git Mirror Deploy', '-c', 'user.email=git-mirror@localhost',
        'merge', '--no-edit', upstream], candidate);
    } catch (error) {
      throw new Error(`Candidate merge failed; the live checkout was not changed. ${error.message}`);
    }
    const merged = await git(['rev-parse', 'HEAD'], candidate);
    for (const command of [...(prepareCommands || []), ...testCommands]) {
      console.log(JSON.stringify({ event: 'deploy.command', program: command[0], args: command.slice(1) }));
      await run(command[0], command.slice(1), candidate);
    }
    if (await git(['status', '--porcelain', '--untracked-files=no'], candidate)) {
      throw new Error('Tests modified tracked candidate files; deployment refused');
    }
    console.log(JSON.stringify({ event: 'deploy.validated', repoId, branch, previous, merged, apply }));
    if (apply) {
      if ((await git(['rev-parse', ref])) !== previous ||
          await git(['status', '--porcelain', '--untracked-files=normal'])) {
        throw new Error('Live checkout changed during validation; deployment refused');
      }
      const backup = `refs/git-mirror-backups/${branch}/${Date.now()}`;
      await git(['update-ref', backup, previous]);
      await git(['merge', '--ff-only', merged]);
      console.log(JSON.stringify({ event: 'deploy.applied', repoId, branch, previous, merged, backup }));
    } else {
      console.log(JSON.stringify({ event: 'deploy.dry_run', repoId, message: 'Run again with --apply to update the checkout' }));
    }
  }
} finally {
  if (worktreeAdded) {
    await git(['worktree', 'remove', '--force', candidate]).catch(error =>
      console.error(JSON.stringify({ event: 'deploy.cleanup_failed', error: error.message })));
  }
  await rm(workspace, { recursive: true, force: true });
}

}
