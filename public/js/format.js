let home = '';

export function setHome(value) {
  home = value || '';
}

export function formatBytes(bytes = 0) {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1);
  const value = bytes / (1000 ** unit);
  return `${value.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

export function formatCount(count = 0) {
  return Number(count).toLocaleString('en-US');
}

export function plural(count, noun, pluralNoun = `${noun}s`) {
  return `${formatCount(count)} ${count === 1 ? noun : pluralNoun}`;
}

export function relativeTime(iso) {
  if (!iso) return 'never';
  const elapsed = new Date(iso).getTime() - Date.now();
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
  const seconds = Math.round(elapsed / 1000);
  const [unit, value] = units.find(([, size]) => Math.abs(seconds) >= size) || units.at(-1);
  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(Math.round(seconds / value), unit);
}

// Compact age for dense columns: "today", "3d", "5w", "4mo", "2y".
export function shortAge(timeMs) {
  if (!timeMs) return '—';
  const days = (Date.now() - timeMs) / 86_400_000;
  if (days < 1) return 'today';
  if (days < 14) return `${Math.floor(days)}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  if (days < 730) return `${Math.floor(days / 30.44)}mo`;
  return `${Math.floor(days / 365.25)}y`;
}

export function formatDate(timeMs) {
  return timeMs
    ? new Date(timeMs).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' })
    : 'unknown';
}

export function tildify(target = '') {
  if (!home || !target) return target;
  if (target === home) return '~';
  return target.startsWith(`${home}/`) ? `~${target.slice(home.length)}` : target;
}

export function basename(target = '') {
  return target.split('/').filter(Boolean).pop() || '/';
}

export function isInside(candidate, root) {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith('/') ? root : `${root}/`);
}

// Breadcrumb segments, starting at ~ for paths inside the home folder.
export function pathSegments(target) {
  if (home && isInside(target, home)) {
    const rest = target.slice(home.length).split('/').filter(Boolean);
    return [{ label: '~', path: home }, ...rest.map((label, index) => ({
      label,
      path: `${home}/${rest.slice(0, index + 1).join('/')}`
    }))];
  }
  const parts = target.split('/').filter(Boolean);
  return [{ label: '/', path: '/' }, ...parts.map((label, index) => ({
    label,
    path: `/${parts.slice(0, index + 1).join('/')}`
  }))];
}
