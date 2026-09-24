// How recently a project was worked on. The scanner records `lastActiveAt` as the
// newest source-file change or Git commit/checkout, whichever is later
// (node_modules, builds, caches, and .DS_Store are ignored).

export const ACTIVITY_LEVELS = ['active', 'recent', 'idle', 'dormant', 'unknown'];

// Days idle at which each level starts. Two weeks covers a weekend or
// side-project rhythm; after about two months dependencies are cheap to
// reinstall, so the project is a cleanup candidate (the inactive filter starts
// here); half a year untouched is dormant.
export const LEVEL_STARTS = { recent: 14, idle: 60, dormant: 180 };

export function daysIdle(timeMs, now = Date.now()) {
  if (!timeMs) return null;
  return Math.max(0, (now - timeMs) / 86_400_000);
}

/**
 * Classify a project by how long it has been idle. This drives the colored dot
 * in the "active" column and the "inactive" filter, which keeps only `idle` and
 * `dormant` projects: the ones you have stopped developing and can clean up.
 *
 * Levels start at the LEVEL_STARTS thresholds: `active` under 14 days, then
 * `recent` from 14, `idle` from 60, and `dormant` from 180. Anything that is
 * not a finite number (null, NaN, Infinity) is `unknown`.
 *
 * @param {number | null} days  Days since the last change, or null when unknown
 *                              (projects scanned before activity tracking).
 * @returns {'active' | 'recent' | 'idle' | 'dormant' | 'unknown'}
 */
export function activityLevel(days) {
  if (!Number.isFinite(days)) return 'unknown';
  if (days >= LEVEL_STARTS.dormant) return 'dormant';
  if (days >= LEVEL_STARTS.idle) return 'idle';
  if (days >= LEVEL_STARTS.recent) return 'recent';
  return 'active';
}

export function isInactive(timeMs) {
  const level = activityLevel(daysIdle(timeMs));
  return level === 'idle' || level === 'dormant';
}
