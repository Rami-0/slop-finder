const path = require('node:path');

// APFS and NTFS are case-insensitive by default. Comparisons that guard deletions
// fold case there, so a differently-cased path can never slip past a protection.
const CASE_INSENSITIVE = process.platform === 'darwin' || process.platform === 'win32';

function fold(value) {
  return CASE_INSENSITIVE ? value.toLowerCase() : value;
}

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isInsideFolded(candidate, root) {
  return isInside(fold(candidate), fold(root));
}

function samePath(a, b) {
  return fold(a) === fold(b);
}

function formatBytes(bytes = 0) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1);
  const value = bytes / (1000 ** unit);
  return `${value.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

module.exports = { fold, isInside, isInsideFolded, samePath, formatBytes };
