import mqtt from 'mqtt';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { loadConfig, mqttOptions, validId, validSha, validHeads, branchPatterns, matchesBranch, git, listHeads, ensureParent, log } from './common.js';

const config = await loadConfig();
const prefix = config.topicPrefix || 'git-mirror/v1';
const repositories = new Map((config.repositories || []).map(r => [r.id, r]));
const clients = new Map((config.clients || []).map(c => [c.id, c]));
const locks = new Map();
for (const repo of repositories.values()) {
  if (!validId(repo.id) || !path.isAbsolute(repo.mirrorPath) || !repo.url) {
    throw new Error('Invalid gateway repository configuration');
  }
  branchPatterns(repo);
}
for (const client of clients.values()) {
  if (!validId(client.id) || !Array.isArray(client.repositories) ||
      !/^https:\/\//.test(client.uploadBaseUrl) || !client.tokenEnv) {
    throw new Error('Invalid gateway client configuration');
  }
}

async function updateMirror(repo) {
  await ensureParent(repo.mirrorPath);
  try {
    if ((await git(['rev-parse', '--is-bare-repository'], { cwd: repo.mirrorPath })) !== 'true') {
      throw new Error('Mirror path is not bare');
    }
  } catch (error) {
    if (!/not a git repository|ENOENT|cannot change to|No such file/i.test(error.message)) throw error;
    await git(['clone', '--mirror', repo.url, repo.mirrorPath], { timeout: 600000 });
  }
  await git(['remote', 'update', '--prune'], { cwd: repo.mirrorPath, timeout: 600000 });
  return listHeads(repo.mirrorPath);
}

async function upload(client, requestId, file, repoId, branches) {
  const token = process.env[client.tokenEnv];
  if (!token) throw new Error(`Missing token environment variable: ${client.tokenEnv}`);
  const size = (await stat(file)).size;
  const base = new URL(client.uploadBaseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('Invalid HTTPS upload URL');
  }
  const target = new URL(`v1/upload/${requestId}`, base.href.endsWith('/') ? base : new URL(base.href + '/'));
  if (target.origin !== base.origin) throw new Error('Upload origin mismatch');
  const response = await fetch(target, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      'content-length': String(size),
      'x-mirror-repo': repoId,
      'x-mirror-branches': JSON.stringify(branches)
    },
    body: createReadStream(file),
    duplex: 'half',
    signal: AbortSignal.timeout(600000),
    redirect: 'error'
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Upload failed (${response.status}): ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

async function processRequest(message) {
  const { clientId, repoId, requestId } = message;
  if (!validId(clientId) || !validId(repoId) || !validId(requestId)) return;
  const client = clients.get(clientId);
  const repo = repositories.get(repoId);
  if (!client || !repo || !client.repositories.includes(repoId)) return;
  const have = message.heads || (validSha(message.have) ? { [repo.branch]: message.have } : {});
  if (!validHeads(have)) return;
  const requested = message.branches || branchPatterns(repo);
  if (!Array.isArray(requested) || !requested.length || requested.length > 100 ||
      !requested.every(p => typeof p === 'string' &&
        (branchPatterns({ id: repoId, branches: [p] }), true))) return;
  const publish = (status, extra = {}) => mq.publish(
    `${prefix}/status/${clientId}`,
    JSON.stringify({ requestId, repoId, status, ...extra }),
    { qos: 1 }
  );
  const work = async () => {
    let dir;
    try {
      const all = await updateMirror(repo);
      const allowed = branchPatterns(repo);
      const heads = Object.fromEntries(Object.entries(all).filter(([name]) =>
        matchesBranch(name, allowed) && matchesBranch(name, requested)));
      if (!Object.keys(heads).length) {
        publish('failed', { error: 'No matching upstream branches' });
        return;
      }
      if (Object.entries(heads).every(([name, head]) => have[name] === head)) {
        publish('unchanged', { heads });
        return;
      }
      dir = await mkdtemp(path.join(tmpdir(), 'git-mirror-'));
      const bundle = path.join(dir, 'repo.bundle');
      const refs = Object.keys(heads).map(name => `refs/heads/${name}`);
      // Only use incremental transfer when every supplied base is available and ancestral.
      const bases = [...new Set(Object.entries(have)
        .filter(([name]) => name in heads).map(([, sha]) => sha).filter(Boolean))];
      let incremental = bases.length > 0;
      for (const base of bases) {
        const exists = await git(['cat-file', '-e', `${base}^{commit}`], { cwd: repo.mirrorPath }).then(() => true, () => false);
        if (!exists) { incremental = false; break; }
      }
      // A missing base for any branch is allowed, but base exclusions must not prevent
      // constructing other branches. Bundle verification on the client is authoritative.
      const args = ['bundle', 'create', bundle, ...refs];
      if (incremental) args.push(...bases.map(sha => `^${sha}`));
      await git(args, { cwd: repo.mirrorPath, timeout: 600000 });
      const result = await upload(client, requestId, bundle, repoId, Object.keys(heads));
      publish('completed', { heads, incremental, result });
      log('sync.completed', { clientId, repoId, heads, incremental });
    } catch (error) {
      publish('failed', { error: error.message });
      log('sync.failed', { clientId, repoId, error: error.message });
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  };
  const previous = locks.get(repoId) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  locks.set(repoId, current);
  current.finally(() => { if (locks.get(repoId) === current) locks.delete(repoId); });
}

const mq = mqtt.connect(process.env.MQTT_URL, mqttOptions());
mq.on('connect', () => {
  mq.subscribe(`${prefix}/request/+`, { qos: 1 });
  log('gateway.connected');
});
mq.on('message', (topic, payload) => {
  try {
    const request = JSON.parse(payload.toString());
    if (topic !== `${prefix}/request/${request.clientId}`) return;
    void processRequest(request);
  } catch (error) { log('request.invalid', { error: error.message }); }
});
mq.on('error', error => log('mqtt.error', { error: error.message }));
log('gateway.started', { repositoryCount: repositories.size, clientCount: clients.size });
