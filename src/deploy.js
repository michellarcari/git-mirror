import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validBranch } from './common.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const configIndex = args.indexOf('--config');
if (args.some((arg, index) => arg !== '--apply' && arg !== '--config' &&
    index !== configIndex + 1) || (configIndex !== -1 && !args[configIndex + 1])) {
  throw new Error('Usage: npm run deploy -- [--config config/deploy.json] [--apply]');
}
const configPath = path.resolve(configIndex < 0 ? (process.env.DEPLOY_CONFIG || 'config/deploy.json') : args[configIndex + 1]);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const { checkoutPath, mirrorPath, branch, prepareCommands, testCommands } = config;

if (!path.isAbsolute(checkoutPath) || !path.isAbsolute(mirrorPath) || !validBranch(branch) ||
    !Array.isArray(testCommands) || !testCommands.length) {
  throw new Error('Config requires absolute checkoutPath/mirrorPath, valid branch, and nonempty testCommands');
}
for (const commands of [prepareCommands || [], testCommands]) {
  if (!Array.isArray(commands) || !commands.every(command =>
    Array.isArray(command) && command.length && command.every(word => typeof word === 'string' && word.length))) {
    throw new Error('Commands must be arrays of nonempty argument strings; shell execution is disabled');
  }
}

async function run(program, commandArgs, cwd, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, commandArgs, {
      cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
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
  console.log(JSON.stringify({ event: 'deploy.prepared', branch, previous, upstream, apply }));
  if (await git(['merge-base', '--is-ancestor', upstream, previous]).then(() => true, () => false)) {
    console.log(JSON.stringify({ event: 'deploy.unchanged', branch, previous }));
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
    console.log(JSON.stringify({ event: 'deploy.validated', branch, previous, merged, apply }));
    if (apply) {
      if ((await git(['rev-parse', ref])) !== previous ||
          await git(['status', '--porcelain', '--untracked-files=normal'])) {
        throw new Error('Live checkout changed during validation; deployment refused');
      }
      const backup = `refs/git-mirror-backups/${branch}/${Date.now()}`;
      await git(['update-ref', backup, previous]);
      await git(['merge', '--ff-only', merged]);
      console.log(JSON.stringify({ event: 'deploy.applied', branch, previous, merged, backup }));
    } else {
      console.log(JSON.stringify({ event: 'deploy.dry_run', message: 'Run again with --apply to update the checkout' }));
    }
  }
} finally {
  if (worktreeAdded) {
    await git(['worktree', 'remove', '--force', candidate]).catch(error =>
      console.error(JSON.stringify({ event: 'deploy.cleanup_failed', error: error.message })));
  }
  await rm(workspace, { recursive: true, force: true });
}
