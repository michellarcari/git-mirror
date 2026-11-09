import http from 'node:http';
import mqtt from 'mqtt';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { loadConfig, mqttOptions, validId, validBranch, branchPatterns, matchesBranch, git, listHeads, ensureParent, log } from './common.js';

const config = await loadConfig();
const clientId = config.clientId;
if (!validId(clientId)) throw new Error('Invalid clientId');
const prefix = config.topicPrefix || 'git-mirror/v1';
const repos = new Map((config.repositories || []).map(repo => [repo.id, repo]));
const token = process.env.UPLOAD_TOKEN;
if (!token || token.length < 24) throw new Error('UPLOAD_TOKEN must be at least 24 characters');
for (const repo of repos.values()) {
  if (!validId(repo.id) || !path.isAbsolute(repo.mirrorPath)) throw new Error('Invalid client repository configuration');
  branchPatterns(repo);
}
const pending = new Map();
const maxBytes = Number(config.maxBundleBytes || 2 * 1024 * 1024 * 1024);
const intervalMs = Math.max(30000, Number(config.syncIntervalSeconds || 300) * 1000);
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
async function requestSync(repo) {
  if (!mq.connected || [...pending.values()].some(p => p.repo.id === repo.id)) return;
  await ensureMirror(repo);
  const patterns = branchPatterns(repo);
  const heads = Object.fromEntries(Object.entries(await listHeads(repo.mirrorPath))
    .filter(([name]) => matchesBranch(name, patterns)));
  const requestId = randomUUID();
  pending.set(requestId, { repo, created: Date.now(), uploading: false });
  mq.publish(`${prefix}/request/${clientId}`,
    JSON.stringify({ clientId, repoId: repo.id, requestId, branches: patterns, heads }),
    { qos: 1 },
    error => {
      if (error) {
        pending.delete(requestId);
        log('request.failed', { repoId: repo.id, error: error.message });
      } else log('request.sent', { repoId: repo.id, branches: patterns, requestId });
    });
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
    log('bundle.applied', { repoId: entry.repo.id, heads, bytes: expected });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, heads, bytes: expected }));
  } catch (error) {
    log('bundle.failed', { repoId: entry.repo.id, error: error.message });
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Bundle validation or import failed' }));
  } finally {
    entry.uploading = false;
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
});
mq.on('connect', () => {
  mq.subscribe(`${prefix}/status/${clientId}`, { qos: 1 });
  log('client.connected', { clientId });
  for (const repo of repos.values()) void requestSync(repo).catch(error => log('sync.error', { repoId: repo.id, error: error.message }));
});
mq.on('message', (topic, data) => {
  try {
    const msg = JSON.parse(data.toString());
    if (topic !== `${prefix}/status/${clientId}` || !validId(msg.requestId)) return;
    if (['completed', 'failed', 'unchanged'].includes(msg.status)) pending.delete(msg.requestId);
    log('sync.status', { repoId: msg.repoId, status: msg.status, heads: msg.heads, error: msg.error });
  } catch (error) { log('status.invalid', { error: error.message }); }
});
mq.on('error', error => log('mqtt.error', { error: error.message }));
setInterval(() => {
  for (const [id, entry] of pending) {
    if (Date.now() - entry.created > 15 * 60 * 1000 && !entry.uploading) pending.delete(id);
  }
  for (const repo of repos.values()) void requestSync(repo).catch(error => log('sync.error', { repoId: repo.id, error: error.message }));
}, intervalMs).unref();
server.listen(config.httpPort || 8787, config.httpHost || '127.0.0.1', () =>
  log('client.started', { clientId, port: config.httpPort || 8787 }));
