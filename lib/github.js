const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

// GitHub features go through the GitHub CLI and the session it already holds.
// Slop Finder never reads or stores the token: git asks `gh auth git-credential`
// for it one command at a time, and nothing is written to any Git config. When gh
// is missing or signed out, the page hides these features and says why.
const GH_ENV = {
  ...process.env,
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_SPINNER_DISABLED: '1',
  NO_COLOR: '1',
  CLICOLOR: '0'
};
// A server started from a GUI often has a short PATH, so the usual install
// locations are checked too.
const FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
const STATUS_TTL_MS = 5 * 60 * 1000;
const REPO_TTL_MS = 2 * 60 * 1000;
const PUSH_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

function runGh(ghPath, args, { cwd, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ghPath, args, { cwd, env: GH_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ code: -1, stdout: '', stderr: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 1024 * 1024) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

let ghPathPromise = null;
function findGh() {
  ghPathPromise ||= (async () => {
    const dirs = [...(process.env.PATH || '').split(path.delimiter).filter(Boolean), ...FALLBACK_DIRS];
    for (const dir of [...new Set(dirs)]) {
      const candidate = path.join(dir, 'gh');
      try {
        await fs.access(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
    return null;
  })();
  return ghPathPromise;
}

// `gh auth status --json hosts` checks each account's token with GitHub. Only the
// active account per host counts, and only when that check succeeded.
async function readStatus() {
  const ghPath = await findGh();
  if (!ghPath) {
    return { installed: false, ready: false, hosts: [], reason: 'GitHub CLI (gh) is not installed. Install it with brew install gh, then run gh auth login.' };
  }
  const result = await runGh(ghPath, ['auth', 'status', '--json', 'hosts']);
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {}
  if (!parsed?.hosts) {
    return { installed: true, ghPath, ready: false, hosts: [], reason: 'Could not read the gh session. Run gh auth status in a terminal to see why.' };
  }
  const active = Object.values(parsed.hosts).flat().filter((account) => account?.active);
  const usable = active.filter((account) => account.state === 'success');
  const primary = usable.find((account) => account.host === 'github.com') || usable[0] || null;
  let reason = null;
  if (!primary) {
    reason = !active.length
      ? 'gh is installed but not signed in. Run gh auth login, then check again.'
      : active.some((account) => account.state === 'timeout')
        ? 'GitHub could not be reached to confirm the gh session. Check your connection.'
        : 'The gh session is no longer valid. Run gh auth login again.';
  }
  return {
    installed: true,
    ghPath,
    ready: Boolean(primary),
    login: primary?.login || null,
    host: primary?.host || null,
    hosts: usable.map((account) => account.host),
    reason
  };
}

let statusCache = null;
async function status({ fresh = false } = {}) {
  if (fresh) {
    ghPathPromise = null;
    statusCache = null;
  }
  if (!statusCache || Date.now() - statusCache.at > STATUS_TTL_MS) {
    statusCache = { at: Date.now(), value: readStatus() };
    // A failed check is not cached, so the next request tries again.
    statusCache.value.catch(() => {
      statusCache = null;
    });
  }
  return statusCache.value;
}

// What the page may see: never the gh binary path, which is only for spawning.
function publicStatus(value) {
  const { ghPath, ...rest } = value;
  return rest;
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// Arguments that make one git command authenticate with the gh session for the
// hosts gh is signed in to. The empty helper clears every helper configured
// elsewhere (a stale keychain entry would otherwise answer first), and insteadOf
// sends SSH remotes for those hosts over HTTPS, where the gh session applies.
function gitAuthArgs(value) {
  if (!value.ready) return [];
  const helper = `!${shellQuote(value.ghPath)} auth git-credential`;
  return value.hosts.flatMap((host) => [
    '-c', `credential.https://${host}.helper=`,
    '-c', `credential.https://${host}.helper=${helper}`,
    '-c', `url.https://${host}/.insteadOf=git@${host}:`,
    '-c', `url.https://${host}/.insteadOf=ssh://git@${host}/`
  ]);
}

function canUseRemote(value, remote) {
  return Boolean(value.ready && remote?.host && !remote.local && value.hosts.includes(remote.host));
}

const repoCache = new Map();
// Visibility and the signed-in account's permission on a GitHub repository.
async function repoInfo(value, remote) {
  if (!canUseRemote(value, remote) || !remote.slug) return null;
  const key = `${remote.host}/${remote.slug}`.toLowerCase();
  const cached = repoCache.get(key);
  if (cached && Date.now() - cached.at < REPO_TTL_MS) return cached.info;
  const name = remote.host === 'github.com' ? remote.slug : `${remote.host}/${remote.slug}`;
  const result = await runGh(value.ghPath, ['repo', 'view', name, '--json',
    'nameWithOwner,url,visibility,viewerPermission,isArchived,isFork,defaultBranchRef,pushedAt']);
  let data = null;
  try {
    data = result.code === 0 ? JSON.parse(result.stdout) : null;
  } catch {}
  let info;
  if (!data) {
    info = { found: false, error: /Could not resolve|not found/i.test(result.stderr)
      ? 'GitHub has no such repository, or this account cannot see it.'
      : 'GitHub did not answer.' };
  } else {
    info = {
      found: true,
      nameWithOwner: data.nameWithOwner,
      url: data.url,
      visibility: String(data.visibility || '').toLowerCase(),
      permission: data.viewerPermission || null,
      canPush: PUSH_PERMISSIONS.has(data.viewerPermission) && !data.isArchived,
      archived: Boolean(data.isArchived),
      fork: Boolean(data.isFork),
      defaultBranch: data.defaultBranchRef?.name || null,
      pushedAt: data.pushedAt || null
    };
  }
  repoCache.set(key, { at: Date.now(), info });
  return info;
}

const OWNER_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_NAME = /^(?!\.{1,2}$)[\w.-]{1,100}$/;

// "name" creates the repository under the signed-in account; "org/name" under an
// organization that account belongs to.
function validRepoName(value) {
  const parts = String(value || '').split('/');
  if (parts.length === 1) return REPO_NAME.test(parts[0]);
  return parts.length === 2 && OWNER_NAME.test(parts[0]) && REPO_NAME.test(parts[1]);
}

// Creates a GitHub repository for a local one that has no remote, adds it as
// origin, and pushes the current branch, all through gh.
async function createRepo(value, root, { name, visibility }) {
  if (!value.ready) throw new Error(value.reason || 'gh is not signed in.');
  if (!validRepoName(name)) throw new Error('Use a name like my-project or my-org/my-project (letters, numbers, dots, dashes, underscores).');
  if (visibility !== 'private' && visibility !== 'public') throw new Error('Choose private or public.');
  const result = await runGh(value.ghPath, ['repo', 'create', name, `--${visibility}`, '--source', '.', '--remote', 'origin', '--push'], {
    cwd: root,
    timeoutMs: 120_000
  });
  if (result.code !== 0) {
    const detail = result.stderr.split('\n').map((line) => line.trim()).filter(Boolean).slice(-2).join(' ');
    throw new Error(result.timedOut ? 'gh took too long to create the repository.' : detail || 'gh could not create the repository.');
  }
  repoCache.clear();
  return { url: result.stdout.trim().split('\n').find((line) => line.startsWith('https://')) || null };
}

module.exports = { canUseRemote, createRepo, gitAuthArgs, publicStatus, repoInfo, status };
