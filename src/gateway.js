import mqtt from 'mqtt';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { loadConfig, mqttOptions, validId, validSha, git, ensureParent, log } from './common.js';

const config = await loadConfig();
const prefix = config.topicPrefix || 'git-mirror/v1';
const repositories = new Map((config.repositories || []).map(r => [r.id, r]));
const clients = new Map((config.clients || []).map(c => [c.id, c]));
const locks = new Map();

for (const repo of repositories.values()) {
  if (!validId(repo.id) || !validId(repo.branch) || !path.isAbsolute(repo.mirrorPath) || !repo.url) {
    throw new Error('Invalid gateway repository configuration');
  }
}
for (const client of clients.values()) {
  if (!validId(client.id) || !Array.isArray(client.repositories) ||
      !/^https:\/\//.test(client.uploadBaseUrl) || !client.tokenEnv) {
    throw new Error('Client configuration must specify an HTTPS uploadBaseUrl, allowed repositories and tokenEnv');
  }
}

async function updateMirror(repo) {
  await ensureParent(repo.mirrorPath);
  try {
    await git(['rev-parse', '--is-bare-repository'], { cwd: repo.mirrorPath });
  } catch {
    await git(['clone', '--mirror', repo.url, repo.mirrorPath], { timeout: 600000 });
  }
  await git(['remote', 'update', '--prune'], { cwd: repo.mirrorPath, timeout: 600000 });
  return git(['rev-parse', `refs/heads/${repo.branch}`], { cwd: repo.mirrorPath });
}

async function upload(client, requestId, file, repoId) {
  const token = process.env[client.tokenEnv];
  if (!token) throw new Error(`Missing gateway token environment variable: ${client.tokenEnv}`);
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
      'x-mirror-repo': repoId
    },
    body: createReadStream(file),
    duplex: 'half',
    signal: AbortSignal.timeout(600000),
    redirect: 'error'
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Client upload failed (${response.status}): ${body.slice(0, 500)}`);
  return JSON.parse(body);
}

async function processRequest(message) {
  const { clientId, repoId, requestId, have } = message;
  if (!validId(clientId) || !validId(repoId) || !validId(requestId) || !validSha(have)) return;
  const client = clients.get(clientId);
  const repo = repositories.get(repoId);
  if (!client || !repo || !client.repositories.includes(repoId)) return;
  const publish = (status, extra = {}) => mq.publish(
    `${prefix}/status/${clientId}`,
    JSON.stringify({ requestId, repoId, status, ...extra }),
    { qos: 1 }
  );
  const work = async () => {
    let dir;
    try {
      const head = await updateMirror(repo);
      if (head === have) {
        publish('unchanged', { head });
        return;
      }
      dir = await mkdtemp(path.join(tmpdir(), 'git-mirror-'));
      const bundle = path.join(dir, 'repo.bundle');
      const baseOk = have && await git(['merge-base', '--is-ancestor', have, head], { cwd: repo.mirrorPath })
        .then(() => true, () => false);
      const ref = `refs/heads/${repo.branch}`;
      const args = ['bundle', 'create', bundle, ref];
      if (baseOk) args.push(`^${have}`);
      await git(args, { cwd: repo.mirrorPath, timeout: 600000 });
      const result = await upload(client, requestId, bundle, repoId);
      publish('completed', { head, incremental: Boolean(baseOk), result });
      log('sync.completed', { clientId, repoId, head, incremental: Boolean(baseOk) });
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
