import 'dotenv/config';
import http from 'node:http';
import mqtt from 'mqtt';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { normalizeUpstream } from './dynamic.js';
import { gatewayRestarted } from './lifecycle.js';
import { syncMode, shouldScheduleSync } from './sync-policy.js';
import { bearerAuthorized, readJson, validateSubscription, saveClientConfig, sendJson } from './admin.js';
import { loadConfig, mqttOptions, validId, validBranch, branchPatterns, matchesBranch, git, listHeads, ensureParent, log } from './common.js';

const config = await loadConfig();
const clientId = config.clientId;
if (!validId(clientId)) throw new Error('Invalid clientId');
const prefix = config.topicPrefix || 'git-mirror/v1';
const repos = new Map((config.repositories || []).map(repo => [repo.id, repo]));
const token = process.env.UPLOAD_TOKEN;
const adminToken = process.env.ADMIN_TOKEN;
const activity = [];
const discoveries = new Map();
let observedGatewayBootId = null;
const adminPage = fileURLToPath(new URL('../public/admin.html', import.meta.url));
function record(event, details = {}) {
  activity.push({ at: new Date().toISOString(), event, ...details });
  if (activity.length > 100) activity.shift();
}
if (!token || token.length < 24) throw new Error('UPLOAD_TOKEN must be at least 24 characters');
for (const repo of repos.values()) {
  if (!validId(repo.id) || !path.isAbsolute(repo.mirrorPath)) throw new Error('Invalid client repository configuration');
  branchPatterns(repo);
}
const pending = new Map();
const maxBytes = Number(config.maxBundleBytes || 2 * 1024 * 1024 * 1024);
const intervalMs = Math.max(30000, Number(config.syncIntervalSeconds || 300) * 1000);
const requestTimeoutMs = Math.max(30000, Number(config.requestTimeoutSeconds || 180) * 1000);
const retryDelayMs = Math.max(5000, Number(config.retryDelaySeconds || 30) * 1000);
const nextAttempt = new Map();
const mode = syncMode(config);
const recovering = new Map();
const maxRecoveryRetries = Math.max(0, Math.min(5, Number(config.maxRecoveryRetries ?? 2)));
const mq = mqtt.connect(process.env.MQTT_URL, mqttOptions());

async function ensureMirror(repo) {
  await ensureParent(repo.mirrorPath);
  try {
    const bare = await git(['rev-parse', '--is-bare-repository'], { cwd: repo.mirrorPath });
    if (bare !== 'true') throw new Error('Mirror path is not bare');
  } catch (error) {
    if (!/not a git repository|ENOENT|cannot change to|No such file/i.test(error.message)) throw error;
    await git(['init', '--bare', repo.mirrorPath]);
  }
}
async function requestSync(repo, force = false, recoveryAttempt = 0) {
  if (!force && Date.now() < (nextAttempt.get(repo.id) || 0)) return false;
  if (!mq.connected || [...pending.values()].some(p => p.repo.id === repo.id)) return false;
  await ensureMirror(repo);
  const patterns = branchPatterns(repo);
  const heads = Object.fromEntries(Object.entries(await listHeads(repo.mirrorPath))
    .filter(([name]) => matchesBranch(name, patterns)));
  const requestId = randomUUID();
  pending.set(requestId, { repo, created: Date.now(), uploading: false, recoveryAttempt });
  nextAttempt.set(repo.id, Date.now() + intervalMs);
  mq.publish(`${prefix}/request/${clientId}`,
    JSON.stringify({ clientId, repoId: repo.id, requestId, branches: patterns, heads, ...(repo.upstream ? { upstream: repo.upstream } : {}) }),
    { qos: 1 },
    error => {
      if (error) {
        pending.delete(requestId);
        recovering.delete(repo.id);
        nextAttempt.set(repo.id, Date.now() + retryDelayMs);
        log('request.failed', { repoId: repo.id, error: error.message });
      } else { log('request.sent', { repoId: repo.id, branches: patterns, requestId }); record('request.sent', { repoId: repo.id }); }
    });
  return true;
}
function authorized(header) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function applyBundle(repo, filename, branches) {
  await ensureMirror(repo);
  const allowed = branchPatterns(repo);
  if (!Array.isArray(branches) || !branches.length || branches.length > 500 ||
      !branches.every(name => validBranch(name) && matchesBranch(name, allowed))) {
    throw new Error('Bundle contains unauthorized branch references');
  }
  await git(['bundle', 'verify', filename], { cwd: repo.mirrorPath, timeout: 600000 });
  const supplied = await git(['bundle', 'list-heads', filename], { cwd: repo.mirrorPath });
  const refs = supplied.split('\n').filter(Boolean).map(line => line.split(' ').slice(1).join(' '));
  if (refs.length !== branches.length ||
      !branches.every(name => refs.includes(`refs/heads/${name}`))) {
    throw new Error('Bundle references do not match authorized branches');
  }
  const refspecs = branches.map(name => `+refs/heads/${name}:refs/heads/${name}`);
  await git(['fetch', '--force', filename, ...refspecs], { cwd: repo.mirrorPath, timeout: 600000 });
  return Object.fromEntries(Object.entries(await listHeads(repo.mirrorPath))
    .filter(([name]) => branches.includes(name)));
}
const server = http.createServer(async (req, res) => {
  const match = /^\/v1\/upload\/([a-f0-9-]{36})$/.exec(req.url || '');
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, clientId }));
    return;
  }
  if (req.method === 'POST' && /^\/v1\/sync\/[a-zA-Z0-9_-]{1,64}$/.test(req.url || '')) {
    if (!authorized(req.headers.authorization)) { res.writeHead(401).end(); return; }
    const repoId = req.url.split('/').at(-1);
    const repo = repos.get(repoId);
    if (!repo) { res.writeHead(404).end(); return; }
    const active = [...pending.values()].some(entry => entry.repo.id === repoId);
    if (active) { res.writeHead(409).end(JSON.stringify({ ok: false, error: 'Sync already in progress' })); return; }
    try {
      const submitted = await requestSync(repo, true);
      res.writeHead(submitted ? 202 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: submitted, repoId, status: submitted ? 'requested' : 'broker_unavailable' }));
    } catch (error) {
      log('sync.error', { repoId, error: error.message });
      res.writeHead(500).end();
    }
    return;
  }
  if (req.method === 'GET' && req.url === '/admin/') {
    const html = await readFile(adminPage, 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
    res.end(html);
    return;
  }
  if (req.url?.startsWith('/v1/admin/')) {
    if (!bearerAuthorized(req.headers.authorization, adminToken)) {
      sendJson(res, 401, { error: 'Invalid administrator token' });
      return;
    }
    const route = req.url.slice('/v1/admin/'.length).split('?')[0];
    try {
      if (req.method === 'GET' && route === 'status') {
        sendJson(res, 200, { clientId, mqttConnected: mq.connected, pending: pending.size,
          repositoryCount: repos.size, syncMode: mode, adminEnabled: true });
        return;
      }
      if (req.method === 'GET' && route === 'activity') {
        sendJson(res, 200, { events: [...activity].reverse() });
        return;
      }
      if (req.method === 'GET' && route === 'repositories') {
        sendJson(res, 200, { repositories: [...repos.values()].map(repo => ({
          id: repo.id, upstream: repo.upstream || null, branches: branchPatterns(repo),
          mirrorPath: repo.mirrorPath,
          pending: [...pending.values()].some(entry => entry.repo.id === repo.id)
        })) });
        return;
      }
      if (req.method === 'POST' && route === 'repositories') {
        const next = validateSubscription(await readJson(req), config, [...repos.values()]);
        if ((config.repositories || []).length >= 100) {
          sendJson(res, 409, { error: 'Repository limit reached' }); return;
        }
        const nextConfig = { ...config, repositories: [...repos.values(), next] };
        await saveClientConfig(process.env.CONFIG_PATH, nextConfig);
        config.repositories = nextConfig.repositories;
        repos.set(next.id, next);
        record('repository.added', { repoId: next.id });
        sendJson(res, 201, { repository: next });
        if (mq.connected) void requestSync(next, true).catch(error =>
          record('sync.error', { repoId: next.id, error: error.message }));
        return;
      }
      if (req.method === 'POST' && route === 'discover') {
        const body = await readJson(req);
        const upstream = normalizeUpstream(body.upstream);
        if (!mq.connected) { sendJson(res, 503, { error: 'MQTT is not connected' }); return; }
        const requestId = randomUUID();
        discoveries.set(requestId, { created: Date.now(), upstream });
        mq.publish(`${prefix}/request/${clientId}`, JSON.stringify({
          clientId, repoId: 'discovery', requestId, upstream, action: 'discover',
          branches: ['main'], heads: {}
        }), { qos: 1 });
        record('repository.discovery_requested', { repoId: upstream });
        sendJson(res, 202, { requestId, status: 'requested' });
        return;
      }
      const repoMatch = /^repositories\/([A-Za-z0-9_-]{1,64})(\/sync)?$/.exec(route);
      if (repoMatch) {
        const repo = repos.get(repoMatch[1]);
        if (!repo) { sendJson(res, 404, { error: 'Repository not found' }); return; }
        if (req.method === 'POST' && repoMatch[2] === '/sync') {
          const result = await requestSync(repo, true);
          sendJson(res, result ? 202 : 409, { ok: result, repoId: repo.id });
          return;
        }
        if (req.method === 'PATCH' && !repoMatch[2]) {
          if ([...pending.values()].some(entry => entry.repo.id === repo.id)) {
            sendJson(res, 409, { error: 'Synchronization is pending' }); return;
          }
          const body = await readJson(req);
          const branches = branchPatterns({ id: repo.id, branches: body.branches });
          const updated = { ...repo, branches };
          const nextConfig = { ...config, repositories: [...repos.values()].map(item =>
            item.id === repo.id ? updated : item) };
          await saveClientConfig(process.env.CONFIG_PATH, nextConfig);
          config.repositories = nextConfig.repositories;
          repos.set(repo.id, updated);
          nextAttempt.set(repo.id, 0);
          record('repository.updated', { repoId: repo.id });
          sendJson(res, 200, { repository: updated });
          return;
        }
        if (req.method === 'DELETE' && !repoMatch[2]) {
          if ([...pending.values()].some(entry => entry.repo.id === repo.id)) {
            sendJson(res, 409, { error: 'Synchronization is pending' }); return;
          }
          const nextConfig = { ...config, repositories: [...repos.values()].filter(item => item.id !== repo.id) };
          await saveClientConfig(process.env.CONFIG_PATH, nextConfig);
          config.repositories = nextConfig.repositories;
          repos.delete(repo.id);
          nextAttempt.delete(repo.id);
          recovering.delete(repo.id);
          record('repository.removed', { repoId: repo.id });
          sendJson(res, 200, { ok: true });
          return;
        }
      }
      sendJson(res, 404, { error: 'Administrative endpoint not found' });
    } catch (error) {
      record('admin.error', { error: error.message });
      sendJson(res, error.status || (error instanceof SyntaxError ? 400 : 400),
        { error: error.message });
    }
    return;
  }
  if (req.method !== 'PUT' || !match) { res.writeHead(404).end(); return; }
  if (!authorized(req.headers.authorization)) { res.writeHead(401).end(); return; }
  const entry = pending.get(match[1]);
  if (!entry || entry.uploading || Date.now() - entry.created > 15 * 60 * 1000 ||
      req.headers['x-mirror-repo'] !== entry.repo.id) {
    res.writeHead(409).end(); return;
  }
  const expected = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(expected) || expected < 1 || expected > maxBytes) {
    res.writeHead(413).end(); return;
  }
  entry.uploading = true;
  let tempDir;
  try {
    const branches = JSON.parse(req.headers['x-mirror-branches'] || 'null');
    tempDir = await mkdtemp(path.join(tmpdir(), 'git-mirror-client-'));
    const filename = path.join(tempDir, 'repo.bundle');
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) req.destroy(new Error('Bundle exceeds size limit'));
    });
    await pipeline(req, createWriteStream(filename, { flags: 'wx' }));
    if ((await stat(filename)).size !== expected) throw new Error('Incomplete transfer');
    const heads = await applyBundle(entry.repo, filename, branches);
    pending.delete(match[1]);
    nextAttempt.set(entry.repo.id, Date.now() + intervalMs);
    log('bundle.applied', { repoId: entry.repo.id, heads, bytes: expected });
    record('bundle.applied', { repoId: entry.repo.id });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, heads, bytes: expected }));
  } catch (error) {
    log('bundle.failed', { repoId: entry.repo.id, error: error.message });
    record('bundle.failed', { repoId: entry.repo.id, error: error.message });
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Bundle validation or import failed' }));
  } finally {
    entry.uploading = false;
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
});
async function sweepAndSync({ reconnect = false, gatewayRestart = false } = {}) {
  for (const [id, entry] of discoveries) {
    if (Date.now() - entry.created > requestTimeoutMs) discoveries.delete(id);
  }
  const expired = [...pending.entries()]
    .filter(([, entry]) => !entry.uploading &&
      (reconnect || gatewayRestart || Date.now() - entry.created >= requestTimeoutMs));
  for (const [requestId, entry] of expired) {
    pending.delete(requestId);
    const nextRetry = entry.recoveryAttempt + 1;
    nextAttempt.set(entry.repo.id, 0);
    const event = gatewayRestart ? 'request.gateway_restarted' :
      reconnect ? 'request.requeued' : 'request.timed_out';
    log(event, { repoId: entry.repo.id, requestId });
    record(event, { repoId: entry.repo.id });
    if (mode === 'manual' && nextRetry <= maxRecoveryRetries) {
      recovering.set(entry.repo.id, nextRetry);
    } else if (mode === 'manual') {
      recovering.delete(entry.repo.id);
      log('request.recovery_exhausted', { repoId: entry.repo.id });
      record('request.recovery_exhausted', { repoId: entry.repo.id });
    }
  }
  if (!mq.connected) return;
  for (const repo of repos.values()) {
    const retry = recovering.get(repo.id);
    if (!shouldScheduleSync(mode, { recovery: retry !== undefined })) continue;
    // Consume the recovery ticket before dispatching. A failed MQTT publish
    // must not create an unlimited retry loop in manual mode.
    if (retry !== undefined) recovering.delete(repo.id);
    await requestSync(repo, mode === 'manual', retry || 0)
      .catch(error => log('sync.error', { repoId: repo.id, error: error.message }));
  }
}
mq.on('connect', () => {
  mq.subscribe([
    `${prefix}/status/${clientId}`,
    `${prefix}/gateway/presence`
  ], { qos: 1 }, error => {
    if (error) { log('mqtt.subscribe_failed', { error: error.message }); return; }
    log('client.connected', { clientId });
    void sweepAndSync({ reconnect: true });
  });
});
mq.on('message', (topic, data) => {
  try {
    const msg = JSON.parse(data.toString());
    if (topic === `${prefix}/gateway/presence`) {
      if (msg?.status !== 'online' || typeof msg.bootId !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(msg.bootId)) return;
      const restarted = gatewayRestarted(observedGatewayBootId, msg.bootId);
      observedGatewayBootId = msg.bootId;
      if (restarted) {
        log('gateway.restarted', { bootId: msg.bootId });
        record('gateway.restarted');
        void sweepAndSync({ gatewayRestart: true }).catch(error =>
          log('sync.error', { error: error.message }));
      }
      return;
    }
    if (topic !== `${prefix}/status/${clientId}` || !validId(msg.requestId)) return;
    if (discoveries.has(msg.requestId)) {
      const discovery = discoveries.get(msg.requestId);
      if (msg.status === 'discovered' || msg.status === 'failed') {
        discoveries.delete(msg.requestId);
        record(msg.status === 'discovered' ? 'repository.discovered' : 'repository.discovery_failed',
          { repoId: discovery.upstream, status: msg.status, branches: msg.branches, error: msg.error });
      }
      return;
    }
    const entry = pending.get(msg.requestId);
    if (!entry || entry.repo.id !== msg.repoId) {
      log('status.stale', { repoId: msg.repoId, requestId: msg.requestId, status: msg.status });
      return;
    }
    if (['completed', 'failed', 'unchanged'].includes(msg.status)) {
      pending.delete(msg.requestId);
      nextAttempt.set(entry.repo.id, Date.now() + (msg.status === 'failed' ? retryDelayMs : intervalMs));
    }
    log('sync.status', { repoId: msg.repoId, status: msg.status, heads: msg.heads, error: msg.error });
    record('sync.status', { repoId: msg.repoId, status: msg.status, error: msg.error });
  } catch (error) { log('status.invalid', { error: error.message }); }
});
mq.on('error', error => log('mqtt.error', { error: error.message }));
setInterval(() => {
  // Expire orphaned requests even while MQTT is disconnected. Requeue on recovery.
  void sweepAndSync().catch(error => log('sync.error', { error: error.message }));
}, 10000).unref();
server.listen(config.httpPort || 8787, config.httpHost || '127.0.0.1', () =>
  log('client.started', { clientId, port: config.httpPort || 8787, syncMode: mode }));
