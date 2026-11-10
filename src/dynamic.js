import path from 'node:path';

const segment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function normalizeUpstream(value) {
  if (typeof value !== 'string') throw new Error('Repository must be organization/name');
  const parts = value.trim().split('/');
  if (parts.length === 2 && parts[1].endsWith('.git')) {
    parts[1] = parts[1].slice(0, -4);
  }
  if (parts.length !== 2 || !parts.every(part =>
      segment.test(part) && !part.startsWith('.') && !part.endsWith('.') &&
      !part.includes('..'))) {
    throw new Error('Invalid organization/repository identifier');
  }
  return parts.join('/');
}

export function resolveDynamicRepository(value, github, dynamicRepositories) {
  const upstream = normalizeUpstream(value);
  if (!github || typeof github.sshHost !== 'string' ||
      !/^[A-Za-z0-9.-]+$/.test(github.sshHost) ||
      !Array.isArray(github.allowedOrganizations) ||
      !path.isAbsolute(dynamicRepositories?.cacheDirectory)) {
    throw new Error('Invalid dynamic gateway configuration');
  }
  const [organization, name] = upstream.split('/');
  const allowed = github.allowedOrganizations.find(item =>
    typeof item === 'string' && item.toLowerCase() === organization.toLowerCase());
  if (!allowed) throw new Error('Repository organization is not allowed');
  const mirrorPath = path.resolve(dynamicRepositories.cacheDirectory, allowed, `${name}.git`);
  const root = path.resolve(dynamicRepositories.cacheDirectory);
  if (!mirrorPath.startsWith(root + path.sep)) throw new Error('Invalid mirror path');
  return {
    id: upstream,
    url: `git@${github.sshHost}:${allowed}/${name}.git`,
    mirrorPath,
    branches: ['main']
  };
}
