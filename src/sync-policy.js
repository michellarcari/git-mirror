export function syncMode(config) {
  const mode = config.syncMode ?? 'manual';
  if (!['manual', 'interval'].includes(mode)) {
    throw new Error('syncMode must be manual or interval');
  }
  return mode;
}

export function shouldScheduleSync(mode, { recovery = false } = {}) {
  return mode === 'interval' || recovery;
}
