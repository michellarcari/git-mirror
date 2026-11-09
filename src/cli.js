import 'dotenv/config';
import { loadConfig, validId } from './common.js';

const [action, repoId] = process.argv.slice(2);
if (action !== 'sync' || !validId(repoId)) {
  console.error('Usage: npm run sync -- <repository-id>');
  process.exitCode = 2;
} else {
  const config = await loadConfig();
  const token = process.env.UPLOAD_TOKEN;
  if (!token) throw new Error('UPLOAD_TOKEN is required');
  if (!(config.repositories || []).some(repo => repo.id === repoId)) {
    throw new Error('Repository is not configured on this client');
  }
  const base = `http://127.0.0.1:${config.httpPort || 8787}`;
  const response = await fetch(`${base}/v1/sync/${repoId}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.text();
  console.log(body);
  if (!response.ok) process.exitCode = 1;
}
