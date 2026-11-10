export function gatewayRestarted(previousBootId, incomingBootId) {
  return typeof previousBootId === 'string' && previousBootId.length > 0 &&
    typeof incomingBootId === 'string' && incomingBootId.length > 0 &&
    previousBootId !== incomingBootId;
}

export function expirePending(pending, now, timeoutMs, { gatewayRestart = false } = {}) {
  const expired = [];
  for (const [requestId, entry] of pending) {
    if (entry.uploading) continue;
    if (gatewayRestart || now - entry.created >= timeoutMs) {
      pending.delete(requestId);
      expired.push({ requestId, repoId: entry.repo.id });
    }
  }
  return expired;
}
