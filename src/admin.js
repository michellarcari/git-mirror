import path from 'node:path';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { normalizeUpstream } from './dynamic.js';
import { validId, branchPatterns } from './common.js';

export function bearerAuthorized(header, secret) {
  if (typeof secret !== 'string' || secret.length < 16 ||
      typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export async function readJson(req, limit = 32768) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) {
      const error = new Error('Request body exceeds the configured limit');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch {
    const error = new Error('Invalid JSON request body');
    error.status = 400;
    throw error;
  }
}
export function validateSubscription(value, config, existing = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validId(value.id)) {
    throw new Error('A valid repository ID is required');
  }
  const upstream = normalizeUpstream(value.upstream);
  const branches = branchPatterns({ id: value.id, branches: value.branches });
  const mirrorRoot = config.mirrorRoot;
  if (!mirrorRoot || !path.isAbsolute(mirrorRoot)) {
    throw new Error('Configure an absolute mirrorRoot before adding repositories');
  }
  if (existing.some(repo => repo.id === value.id ||
    (repo.upstream?.toLowerCase() === upstream.toLowerCase() && repo.id !== value.id))) {
    throw new Error('Repository ID or upstream already configured');
  }
  const mirrorPath = path.resolve(mirrorRoot, `${value.id}.git`);
  if (!mirrorPath.startsWith(path.resolve(mirrorRoot) + path.sep)) {
    throw new Error('Invalid repository path');
  }
  if (existing.some(repo => path.resolve(repo.mirrorPath) === mirrorPath)) {
    throw new Error('Repository path already configured');
  }
  return { id: value.id, upstream, branches, mirrorPath };
}
export async function saveClientConfig(filename, config) {
  const absolute = path.resolve(filename);
  const temp = `${absolute}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, absolute);
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(temp, { force: true });
  }
}
export function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  });
  res.end(JSON.stringify(body));
}
