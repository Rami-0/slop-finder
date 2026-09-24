// How recently a project was worked on. The scanner records `lastActiveAt` as the
// newest source-file change or Git commit/checkout, whichever is later
// (node_modules, builds, caches, and .DS_Store are ignored).

export const ACTIVITY_LEVELS = ['active', 'recent', 'idle', 'dormant', 'unknown'];

export function daysIdle(timeMs, now = Date.now()) {
  if (!timeMs) return null;
  return Math.max(0, (now - timeMs) / 86_400_000);
}

/**
 * Classify a project by how long it has been idle. This drives the colored dot
 * in the "active" column and the "inactive" filter, which keeps only `idle` and
 * `dormant` projects: the ones you have stopped developing and can clean up.
 *
 * @param {number | null} days  Days since the last change, or null when unknown
 *                              (projects scanned before activity tracking).
 * @returns {'active' | 'recent' | 'idle' | 'dormant' | 'unknown'}
 */
export function activityLevel(days) {
  if (days == null) return 'unknown';
  // TODO(you): choose where each level starts.
  return 'unknown';
}

export function isInactive(timeMs) {
  const level = activityLevel(daysIdle(timeMs));
  return level === 'idle' || level === 'dormant';
}
