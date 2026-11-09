import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export async function loadConfig() {
  const filename = process.env.CONFIG_PATH;
  if (!filename) throw new Error('CONFIG_PATH must reference a JSON configuration file');
  return JSON.parse(await readFile(path.resolve(filename), 'utf8'));
}
export function mqttOptions() {
  return {
    username: process.env.MQTT_USERNAME, password: process.env.MQTT_PASSWORD,
    reconnectPeriod: 2000, connectTimeout: 15000, clean: true,
    clientId: `git-mirror-${process.env.MIRROR_NODE_ID || process.pid}`
  };
}
export function validId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}
export function validSha(value) {
  return value === null || (typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value));
}
export function validBranch(value) {
  return typeof value === 'string' && value.length <= 200 &&
    /^[a-zA-Z0-9_-][a-zA-Z0-9_./-]*$/.test(value) &&
    !value.includes('..') && !value.includes('//') && !value.endsWith('/') &&
    !value.endsWith('.') && !value.endsWith('.lock') && !value.includes('@{') &&
    !value.split('/').some(part => part.startsWith('.'));
}
export function branchPatterns(repo) {
  const branches = repo.branches ?? (repo.branch ? [repo.branch] : []);
  if (!Array.isArray(branches) || !branches.length || branches.length > 100 ||
      !branches.every(pattern => typeof pattern === 'string' &&
        (validBranch(pattern) || (pattern.endsWith('/*') && validBranch(pattern.slice(0, -2)))))) {
    throw new Error(`Invalid branches for repository ${repo.id}`);
  }
  return branches;
}
export function matchesBranch(branch, patterns) {
  return patterns.some(pattern => pattern.endsWith('/*')
    ? branch.startsWith(pattern.slice(0, -1)) && branch.length > pattern.length - 1
    : branch === pattern);
}
export function validHeads(heads) {
  return heads !== null && typeof heads === 'object' && !Array.isArray(heads) &&
    Object.keys(heads).length <= 500 &&
    Object.entries(heads).every(([branch, sha]) => validBranch(branch) && validSha(sha));
}
export async function git(args, { cwd, timeout = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd, shell: false,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', b => { stdout += b.toString(); });
    child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-8000); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args[0]} failed (${code}): ${stderr.trim()}`));
    });
  });
}
export async function listHeads(cwd) {
  const output = await git(['for-each-ref', '--format=%(refname:strip=2) %(objectname)', 'refs/heads/'], { cwd });
  return Object.fromEntries(output.split('\n').filter(Boolean).map(line => {
    const index = line.lastIndexOf(' ');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}
export async function ensureParent(filename) {
  await mkdir(path.dirname(filename), { recursive: true });
}
export function log(event, details = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), event, ...details }));
}
