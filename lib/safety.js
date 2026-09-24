const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { APP_DIR, DATA_DIR, HOME } = require('./config');
const { fold, isInsideFolded, samePath } = require('./paths');

// Nothing inside these trees is ever deleted, whatever locations the user allows.
const SYSTEM_TREES = process.platform === 'darwin'
  ? ['/System', '/Library', '/Applications', '/usr', '/bin', '/sbin', '/etc', '/private/etc', '/private/var/db',
    '/cores', '/dev', '/opt/homebrew', '/opt/local', '/nix']
  : ['/proc', '/sys', '/dev', '/run', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/etc', '/var/lib', '/snap', '/nix'];

// Home folders that hold app data, credentials, or the Trash itself.
const HOME_TREES = ['Library', 'Applications', '.ssh', '.gnupg', '.aws', '.kube', '.docker', '.config', '.local',
  '.Trash', '.password-store'].map((name) => path.join(HOME, name));

// Standard home folders can be cleaned out, but never removed as a whole.
const HOME_FOLDERS = ['Desktop', 'Documents', 'Downloads', 'Movies', 'Music', 'Pictures', 'Public']
  .map((name) => path.join(HOME, name));

const METADATA_SEGMENTS = new Set(['.git', '.hg', '.svn']);

// Always-allowed locations: the home folder and the temporary folders. The
// per-user temporary folder ($TMPDIR) is a different path on every Mac and for
// every user (/private/var/folders/<xx>/<id>/T), so it is found at runtime and
// shown by name. Only that T folder is allowed: its siblings C, 0 and X hold live
// caches and state for macOS services, and the rest of /private/var is the system's.
const BUILTIN_CANDIDATES = [
  { candidate: HOME, label: '~', note: 'your home folder' },
  { candidate: '/private/tmp', label: '/tmp', note: 'the shared temporary folder' },
  { candidate: '/tmp', label: '/tmp', note: 'the shared temporary folder' },
  { candidate: os.tmpdir(), label: '$TMPDIR', note: 'your own temporary folder; its path differs on every Mac and for every user' }
];

let builtinPromise;
function builtinLocations() {
  builtinPromise ||= (async () => {
    const found = new Map();
    for (const { candidate, label, note } of BUILTIN_CANDIDATES) {
      try {
        const real = await fs.realpath(candidate);
        if (!found.has(real)) found.set(real, { path: real, label, note });
      } catch {}
    }
    return [...found.values()];
  })();
  return builtinPromise;
}

async function builtinRoots() {
  return (await builtinLocations()).map((location) => location.path);
}

const PROTECTED_SUMMARY = process.platform === 'darwin'
  ? 'System folders (/System, /usr, /opt/homebrew and similar), ~/Library, credential folders (~/.ssh, ~/.aws, ~/.config, …), ' +
    'the Trash, .git/.hg/.svn metadata, mounted volumes, and Slop Finder itself. Your home folder and Desktop, Documents, ' +
    'Downloads and the other standard folders can be cleaned inside, but never removed whole.'
  : 'System folders (/usr, /etc, /var/lib and similar), credential folders (~/.ssh, ~/.aws, ~/.config, …), the Trash, ' +
    '.git/.hg/.svn metadata, mounted volumes, and Slop Finder itself. Your home folder and its standard folders can be ' +
    'cleaned inside, but never removed whole.';

// Why a folder may not become an extra allowed location, or null when it can.
function rootRejection(real) {
  if (real === path.parse(real).root) return 'The whole disk cannot be an allowed location.';
  if (isInsideFolded(HOME, real)) return samePath(HOME, real)
    ? 'Your home folder is already allowed.'
    : 'This folder contains your home folder. Pick a more specific location.';
  if (isInsideFolded(real, HOME)) return 'Everything inside your home folder is already allowed.';
  if (SYSTEM_TREES.some((tree) => isInsideFolded(real, tree) || isInsideFolded(tree, real))) {
    return 'System locations cannot be allowed.';
  }
  if (process.platform === 'darwin') {
    if (samePath(real, '/Volumes')) return 'Pick a specific drive inside /Volumes.';
    if (isInsideFolded(real, '/private/var')) return 'System locations cannot be allowed.';
  }
  return null;
}

async function resolveExtraRoot(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Enter a folder path.');
  const expanded = input.trim().replace(/^~(?=$|\/)/, HOME);
  if (!path.isAbsolute(expanded)) throw new Error('Use an absolute path, such as /Volumes/Archive.');
  let real;
  try {
    real = await fs.realpath(expanded);
  } catch {
    throw new Error('That folder does not exist.');
  }
  if (!(await fs.stat(real)).isDirectory()) throw new Error('That path is a file, not a folder.');
  const rejection = rootRejection(real);
  if (rejection) throw new Error(rejection);
  return real;
}

// Built-in roots plus the user's extra locations. Extra locations arrive from the
// browser on every request, so each one is validated again here; invalid ones
// simply grant nothing.
async function allowedRoots(extraRoots = []) {
  const roots = [...await builtinRoots()];
  for (const root of Array.isArray(extraRoots) ? extraRoots.slice(0, 32) : []) {
    try {
      roots.push(await resolveExtraRoot(root));
    } catch {}
  }
  return [...new Set(roots)];
}

// Why `real` (a canonical path) may not be deleted, or null when it may.
function protectionReason(real, roots) {
  if (real === path.parse(real).root) return 'The top of the disk is protected.';
  if (real.split(path.sep).some((segment) => METADATA_SEGMENTS.has(fold(segment)))) {
    return 'Version-control metadata is protected. Delete the whole project folder instead.';
  }
  if (SYSTEM_TREES.some((tree) => isInsideFolded(real, tree))) return 'System files are protected.';
  const homeTree = HOME_TREES.find((tree) => isInsideFolded(real, tree));
  if (homeTree) return `~/${path.basename(homeTree)} holds app data or credentials and is protected.`;
  if (isInsideFolded(real, APP_DIR) || isInsideFolded(real, DATA_DIR)) return "Slop Finder's own files are protected.";
  if (isInsideFolded(HOME, real)) return 'Your home folder is protected.';
  if (isInsideFolded(APP_DIR, real)) return 'This folder contains Slop Finder itself.';
  if (HOME_FOLDERS.some((folder) => samePath(real, folder))) return 'Standard home folders are protected. Delete things inside them instead.';
  if (roots.some((root) => samePath(real, root))) return 'Allowed locations are protected themselves. Delete things inside them instead.';
  if (!roots.some((root) => isInsideFolded(real, root))) {
    return 'Outside the allowed locations. Add this drive or folder under Delete locations to allow it.';
  }
  return null;
}

// The canonical location of an entry: parent symlinks are resolved, but a symlink
// entry itself stays a symlink (deleting it removes the link, never its target).
async function canonicalPath(target, stats) {
  return stats.isSymbolicLink()
    ? path.join(await fs.realpath(path.dirname(target)), path.basename(target))
    : fs.realpath(target);
}

function isNormalizedAbsolute(target) {
  return typeof target === 'string' &&
    path.isAbsolute(target) &&
    path.normalize(target) === target &&
    !(target.length > 1 && target.endsWith(path.sep));
}

async function checkDeletable(target, { roots, extraRoots } = {}) {
  if (!isNormalizedAbsolute(target)) return { ok: false, reason: 'Paths must be absolute, with no trailing slash.' };
  let stats;
  try {
    stats = await fs.lstat(target);
  } catch {
    return { ok: false, reason: 'This item no longer exists.' };
  }
  let real;
  try {
    real = await canonicalPath(target, stats);
  } catch {
    return { ok: false, reason: 'Could not resolve where this item lives.' };
  }
  const reason = protectionReason(real, roots || await allowedRoots(extraRoots));
  if (reason) return { ok: false, reason, real };
  if (stats.isDirectory()) {
    let parent;
    try {
      parent = await fs.stat(path.dirname(real));
    } catch {
      return { ok: false, reason: 'Could not check the folder that contains this item.', real };
    }
    if (parent.dev !== stats.dev) return { ok: false, reason: 'This is a mounted volume. Clean it from inside instead.', real };
  }
  return { ok: true, real, stats };
}

async function describeLocations() {
  return {
    home: HOME,
    builtin: await builtinLocations(),
    protectedSummary: PROTECTED_SUMMARY,
    protectedTrees: [...SYSTEM_TREES, ...HOME_TREES, APP_DIR],
    protectedFolders: [HOME, ...HOME_FOLDERS],
    protectedNames: [...METADATA_SEGMENTS]
  };
}

module.exports = {
  allowedRoots,
  canonicalPath,
  checkDeletable,
  describeLocations,
  isNormalizedAbsolute,
  protectionReason,
  resolveExtraRoot,
  rootRejection
};
