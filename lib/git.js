const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { mapLimit } = require('./limit');
const rules = require('./rules');

// Git plumbing. Everything here reads, except commitAll() and push(), which only
// run when the user asks for them in the page. GIT_OPTIONAL_LOCKS=0 stops
// `git status` from refreshing (writing) the index.
const GIT_ENV = {
  ...process.env,
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  LC_ALL: 'C'
};

// A repository's own config can name a program for `git status` to run
// (core.fsmonitor). Status now runs in every indexed repository, including ones
// downloaded from elsewhere, so that hook is always switched off.
const SAFE_CONFIG = ['-c', 'core.fsmonitor=false'];

const FILE_LIST_LIMIT = 400;
const REVIEW_FILE_LIMIT = 5000;
const WRITE_TIMEOUT_MS = 120_000;
const WARN_FILE_BYTES = 50_000_000;
const MAX_FILE_BYTES = 100_000_000;

function runGit(args, cwd, { timeoutMs = 8000, maxBytes = 512 * 1024, onData, captureErrors = false } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', [...SAFE_CONFIG, ...args], { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', captureErrors ? 'pipe' : 'ignore'] });
    } catch {
      resolve({ code: -1, stdout: '', stderr: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    // Decoding as a stream keeps multi-byte file names intact across chunks.
    if (!onData) child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (onData) onData(chunk);
      else if (stdout.length < maxBytes) stdout += chunk;
      else truncated = true;
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: '', stderr, truncated, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, truncated, timedOut });
    });
  });
}

// How the repository around `real` sees it: tracked (part of the source),
// ignored (what .gitignore says is disposable), untracked, unknown (Git could not
// tell), or none (not inside a repository).
async function pathStatus(real) {
  const parent = path.dirname(real);
  const name = path.basename(real);
  const top = await runGit(['rev-parse', '--show-toplevel'], parent);
  if (top.code !== 0) return { state: 'none', repo: null, trackedFiles: 0 };
  const repo = top.stdout.trim();
  let trackedFiles = 0;
  // Literal pathspecs stop a folder named ":/" from meaning "the whole repository".
  const listed = await runGit(['--literal-pathspecs', 'ls-files', '-z', '--', name], parent, {
    onData: (chunk) => {
      for (const byte of chunk) if (byte === 0) trackedFiles += 1;
    }
  });
  if (trackedFiles) return { state: 'tracked', repo, trackedFiles };
  if (listed.code !== 0) return { state: 'unknown', repo, trackedFiles: 0 };
  // check-ignore exits 0 when ignored, 1 when not, and 128 when it cannot decide.
  const ignored = await runGit(['check-ignore', '-q', '--', name], parent);
  const state = ignored.code === 0 ? 'ignored' : ignored.code === 1 ? 'untracked' : 'unknown';
  return { state, repo, trackedFiles: 0 };
}

// `git status --porcelain=v2 --branch -z`: NUL-separated headers and entries.
// Renames (type 2) carry their original path as the next token.
function parseStatus(raw) {
  const tokens = raw.split('\0');
  const branch = { oid: null, head: null, upstream: null, ahead: 0, behind: 0 };
  const files = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.startsWith('# ')) {
      const [key, ...rest] = token.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') branch.oid = value === '(initial)' ? null : value;
      else if (key === 'branch.head') branch.head = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') branch.upstream = value;
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) [branch.ahead, branch.behind] = [Number(match[1]), Number(match[2])];
      }
      continue;
    }
    const fields = token.split(' ');
    if (token[0] === '1') files.push({ xy: fields[1], path: fields.slice(8).join(' ') });
    else if (token[0] === '2') files.push({ xy: fields[1], path: fields.slice(9).join(' '), from: tokens[++index] });
    else if (token[0] === 'u') files.push({ xy: fields[1], path: fields.slice(10).join(' '), conflicted: true });
    else if (token[0] === '?') files.push({ xy: '??', path: token.slice(2), untracked: true });
  }
  return { branch, files };
}

function countChanges(files) {
  const changes = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, total: files.length };
  for (const file of files) {
    if (file.conflicted) changes.conflicted += 1;
    else if (file.untracked) changes.untracked += 1;
    else {
      if (file.xy[0] !== '.') changes.staged += 1;
      if (file.xy[1] !== '.') changes.unstaged += 1;
    }
  }
  return changes;
}

// Credentials can live in a remote URL (https://<token>@github.com/...), so the
// user part never leaves the server. Everything else is kept as Git shows it.
function redactUrl(url) {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
}

// Where a remote points: host and owner/repo for hosted remotes (URL or
// scp-style "git@host:owner/repo"), or `local` when it is a folder on this machine
// and so not a copy anywhere else.
function describeRemote(name, rawUrl) {
  const url = redactUrl(rawUrl);
  let host = null;
  let repoPath = null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(rawUrl);
  const scp = !scheme && /^(?:[^@/]+@)?([^/:]{2,}):(?!\/\/)(.+)$/.exec(rawUrl);
  if (scheme && scheme[1].toLowerCase() !== 'file') [host, repoPath] = [scheme[2].toLowerCase(), scheme[3]];
  else if (scp) [host, repoPath] = [scp[1].toLowerCase(), scp[2]];
  if (!host) return { name, url, host: null, slug: null, web: null, local: true };
  const slug = repoPath.replace(/\/+$/, '').replace(/\.git$/i, '');
  // Only plain host and path characters become a clickable link.
  const web = /^[a-z0-9.-]+$/.test(host) && /^[\w.-]+\/[\w./-]+$/.test(slug) ? `https://${host}/${slug}` : null;
  return { name, url, host, slug, web, local: false };
}

function parseRemotes(output) {
  const byName = new Map();
  for (const line of output.split('\n')) {
    const match = /^(\S+)\t(.+) \((fetch|push)\)$/.exec(line);
    if (match && (match[3] === 'fetch' || !byName.has(match[1]))) byName.set(match[1], match[2]);
  }
  return [...byName].map(([name, url]) => describeRemote(name, url));
}

function splitUpstream(upstream, remotes) {
  if (!upstream) return null;
  const remote = remotes
    .filter((candidate) => upstream.startsWith(`${candidate.name}/`))
    .sort((a, b) => b.name.length - a.name.length)[0];
  return remote
    ? { name: upstream, remote: remote.name, branch: upstream.slice(remote.name.length + 1) }
    : { name: upstream, remote: null, branch: upstream };
}

function listCount(output) {
  return output.split('\n').filter(Boolean).length;
}

// Everything that decides whether deleting this repository could lose work,
// from local data only (no network): uncommitted changes, commits that no
// remote-tracking branch contains, stashes, and where the remotes point.
// Remote-tracking branches are only as fresh as the last fetch, so the time of
// that fetch is reported too.
async function overview(root) {
  const checkedAt = new Date().toISOString();
  const [status, remotes, stashes, localOnly, lastCommit, commonDir, refs] = await Promise.all([
    runGit(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'], root, { maxBytes: 4 * 1024 * 1024, timeoutMs: 20_000 }),
    runGit(['remote', '-v'], root),
    runGit(['stash', 'list', '--format=%gd'], root),
    // With no remotes at all this counts every commit: all of them exist only here.
    runGit(['rev-list', '--count', '--branches', '--not', '--remotes'], root, { timeoutMs: 20_000 }),
    runGit(['log', '-1', '--format=%H%x00%ct%x00%s'], root),
    runGit(['rev-parse', '--git-common-dir'], root),
    // Every branch tip and remote-tracking ref: a check against the remote only
    // stays valid while none of them moves (lib/repos.js, snapshot()).
    runGit(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads', 'refs/remotes'], root, { maxBytes: 4 * 1024 * 1024 })
  ]);
  if (status.code !== 0) {
    return { state: 'unreadable', root, checkedAt, error: status.timedOut ? 'Git took too long to answer.' : 'Git could not read this repository.' };
  }
  const { branch, files } = parseStatus(status.stdout);
  const remoteList = parseRemotes(remotes.stdout);
  const upstream = splitUpstream(branch.upstream, remoteList);
  const origin = remoteList.find((remote) => remote.name === upstream?.remote) ||
    remoteList.find((remote) => remote.name === 'origin') || remoteList[0] || null;
  const [hash, time, subject] = lastCommit.code === 0 ? lastCommit.stdout.trim().split('\0') : [];
  let lastFetchAt = null;
  if (commonDir.code === 0) {
    try {
      const fetched = await fs.stat(path.join(path.resolve(root, commonDir.stdout.trim()), 'FETCH_HEAD'));
      lastFetchAt = fetched.mtime.toISOString();
    } catch {}
  }
  return {
    state: 'repository',
    root,
    checkedAt,
    branch: branch.head,
    detached: Boolean(branch.oid) && !branch.head,
    head: branch.oid,
    // A cut-off listing could hide a moved ref, so it is treated like a failed one.
    refsHash: refs.code === 0 && !refs.truncated ? crypto.createHash('sha256').update(refs.stdout).digest('hex') : null,
    hasCommits: Boolean(branch.oid),
    upstream,
    ahead: branch.ahead,
    behind: branch.behind,
    localOnlyCommits: Number(localOnly.stdout.trim()) || 0,
    changes: countChanges(files),
    changesTruncated: status.truncated,
    stashes: listCount(stashes.stdout),
    remotes: remoteList,
    origin,
    lastCommit: hash ? { hash, at: new Date(Number(time) * 1000).toISOString(), subject } : null,
    lastFetchAt
  };
}

// The repository that holds `target`: its full overview when `target` is the
// top of a repository, where that repository is when `target` is inside one,
// and `none` when no Git repository contains it.
async function locate(target) {
  const checkedAt = new Date().toISOString();
  let real;
  try {
    real = await fs.realpath(target);
  } catch {
    return { state: 'missing', checkedAt };
  }
  const top = await runGit(['rev-parse', '--show-toplevel'], real, { captureErrors: true });
  if (top.code !== 0) {
    // Git refuses repositories owned by another user until they are marked safe.
    if (/dubious ownership/.test(top.stderr)) return { state: 'unreadable', root: real, checkedAt, error: 'Owned by another user, so Git will not read it.' };
    return { state: 'none', checkedAt };
  }
  const root = top.stdout.trim();
  return root === real ? overview(root) : { state: 'inside', root, checkedAt };
}

// Local branches whose tips hold commits that no remote-tracking branch contains.
async function localOnlyBranches(root) {
  const result = await runGit(['log', '--branches', '--not', '--remotes', '--simplify-by-decoration',
    '--decorate-refs=refs/heads', '--format=%D'], root, { timeoutMs: 20_000 });
  const names = new Set();
  for (const line of result.stdout.split('\n')) {
    for (const ref of line.split(', ')) {
      const name = ref.replace(/^HEAD -> /, '').trim();
      if (name && name !== 'HEAD' && !name.startsWith('tag: ')) names.add(name);
    }
  }
  return [...names];
}

// Folders that tools recreate. Committing one pushes thousands of generated files,
// so a commit is refused until .gitignore covers it. Names that some projects use
// for hand-written files (dist, build, vendor, ...) only warn.
const REBUILDABLE_NAMES = new Set(rules.ARTIFACT_RULES
  .filter((rule) => !rule.requires && !rule.requiresMatch && !rule.ambiguous)
  .map((rule) => rule.name));
const AMBIGUOUS_NAMES = new Set(rules.ARTIFACT_RULES.filter((rule) => rule.ambiguous).map((rule) => rule.name));

// File names that usually hold secrets. Example and template files are fine.
const SECRET_NAME = /^(\.env(\..+)?|\.netrc|\.npmrc|\.pypirc|\.pgpass|id_(rsa|dsa|ecdsa|ed25519)|.+\.(pem|p12|pfx|key|keystore|jks|ppk|mobileprovision)|credentials(\.json)?|.*service[-_]?account.*\.json|.*secrets?\.(json|ya?ml|toml|txt))$/i;
const SECRET_EXEMPT = /\.(example|sample|template|dist|defaults?)$/i;

// What would go wrong if every change were committed and pushed as-is. `block`
// entries stop the commit; `warn` entries need an explicit confirmation.
async function commitWarnings(root, files, truncated) {
  const warnings = [];
  const add = (level, text, paths = []) => warnings.push({ level, text, paths: paths.slice(0, 12), more: Math.max(0, paths.length - 12) });
  if (truncated || files.length > REVIEW_FILE_LIMIT) {
    add('block', `More than ${REVIEW_FILE_LIMIT.toLocaleString('en-US')} changed files. That is usually a missing .gitignore entry; commit from a terminal after checking.`);
    return warnings;
  }
  const conflicted = files.filter((file) => file.conflicted).map((file) => file.path);
  if (conflicted.length) add('block', 'Resolve the merge conflicts first.', conflicted);

  const incoming = files.filter((file) => file.untracked || file.xy[0] === 'A' || file.xy[1] === 'A');
  const rebuildable = new Map();
  const ambiguous = new Map();
  for (const file of incoming) {
    const segments = file.path.split('/');
    const hit = segments.findIndex((segment) => REBUILDABLE_NAMES.has(segment));
    if (hit >= 0) rebuildable.set(segments.slice(0, hit + 1).join('/'), true);
    const maybe = segments.slice(0, -1).findIndex((segment) => AMBIGUOUS_NAMES.has(segment));
    if (hit < 0 && maybe >= 0) ambiguous.set(segments.slice(0, maybe + 1).join('/'), true);
  }
  if (rebuildable.size) {
    add('block', 'Rebuildable folders would be committed. Add them to .gitignore first.', [...rebuildable.keys()].map((folder) => `${folder}/`));
  }
  if (ambiguous.size) {
    add('warn', 'These folders are often build output. Commit them only if they hold hand-written files.', [...ambiguous.keys()].map((folder) => `${folder}/`));
  }

  const secrets = files
    .filter((file) => !file.xy.includes('D'))
    .map((file) => file.path)
    .filter((filePath) => SECRET_NAME.test(path.basename(filePath)) && !SECRET_EXEMPT.test(filePath));
  if (secrets.length) add('warn', 'These files often hold passwords, keys, or tokens. Check them before they leave this Mac.', secrets);

  const sized = await mapLimit(files.filter((file) => !file.xy.includes('D')), 16, async (file) => {
    try {
      return { path: file.path, bytes: (await fs.lstat(path.join(root, file.path))).size };
    } catch {
      return { path: file.path, bytes: 0 };
    }
  });
  const tooBig = sized.filter((file) => file.bytes > MAX_FILE_BYTES).map((file) => file.path);
  const big = sized.filter((file) => file.bytes > WARN_FILE_BYTES && file.bytes <= MAX_FILE_BYTES).map((file) => file.path);
  if (tooBig.length) add('block', 'Files over 100 MB, which GitHub rejects.', tooBig);
  if (big.length) add('warn', 'Files over 50 MB. GitHub accepts them but warns, and they bloat every clone.', big);
  return warnings;
}

// The overview plus what the page needs to review a commit: the changed files,
// the warnings, and a fingerprint of the exact state that was shown, so a commit
// only goes ahead if nothing changed since the review.
async function details(root) {
  const [base, full, branches] = await Promise.all([
    overview(root),
    runGit(['status', '--porcelain=v2', '-z', '--untracked-files=all'], root, { maxBytes: 8 * 1024 * 1024, timeoutMs: 30_000 }),
    localOnlyBranches(root)
  ]);
  if (base.state !== 'repository') return base;
  const { files } = parseStatus(full.stdout);
  return {
    ...base,
    files: files.slice(0, FILE_LIST_LIMIT),
    fileCount: files.length,
    filesTruncated: full.truncated || files.length > FILE_LIST_LIMIT,
    fingerprint: crypto.createHash('sha256').update(full.stdout).digest('hex'),
    localOnlyBranches: branches,
    warnings: await commitWarnings(root, files, full.truncated)
  };
}

function lastLines(text, count = 4) {
  return text.split('\n').map((line) => line.replace(/^(remote|hint|error|fatal): ?/, '').trim()).filter(Boolean).slice(-count).join(' ');
}

// Stages every change (what .gitignore allows) and commits it, after checking the
// working tree still matches the reviewed fingerprint. Hooks run as they would in
// a terminal.
async function commitAll(root, { message, fingerprint, acceptWarnings = false }) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) throw new Error('Write a commit message.');
  if (text.length > 4000) throw new Error('The commit message is too long.');
  const current = await details(root);
  if (current.state !== 'repository') throw new Error('This folder is not the top of a Git repository.');
  if (!current.fileCount) throw new Error('There is nothing to commit.');
  if (current.fingerprint !== fingerprint) throw new Error('The changes are different from what you reviewed. Review them again.');
  const blocker = current.warnings.find((warning) => warning.level === 'block');
  if (blocker) throw new Error(blocker.text);
  if (current.warnings.length && !acceptWarnings) throw new Error('Confirm the warnings before committing.');

  const staged = await runGit(['add', '--all'], root, { captureErrors: true, timeoutMs: WRITE_TIMEOUT_MS });
  if (staged.code !== 0) throw new Error(`Could not stage the changes: ${lastLines(staged.stderr) || 'git add failed.'}`);
  const committed = await runGit(['commit', '--quiet', '-m', text], root, { captureErrors: true, timeoutMs: WRITE_TIMEOUT_MS });
  if (committed.code !== 0) {
    if (/Author identity unknown|tell me who you are/i.test(committed.stderr)) {
      throw new Error('Git does not know who you are yet. Set user.name and user.email with git config --global, then commit again.');
    }
    throw new Error(committed.timedOut ? 'The commit took too long (a hook may be waiting for input).' : `Commit failed: ${lastLines(committed.stderr) || 'git commit failed.'}`);
  }
  return overview(root);
}

// Remote and branch names come from the repository's own config, so they are
// checked before they become arguments.
const SAFE_NAME = /^(?!-)[\w./-]+$/;

// Pushes one local branch (the current one unless another is named) to its
// upstream, or sets one up on the primary remote. `checkRemote` may refuse the
// remote first. The refspec is explicit and never starts with "+", so a push can
// only fast-forward: force-push or mirror settings in the repository config do not apply.
async function push(root, { authArgs, branch: requested = null, checkRemote }) {
  const view = await overview(root);
  if (view.state !== 'repository') throw new Error('This folder is not the top of a Git repository.');
  if (!view.hasCommits) throw new Error('There are no commits to push yet.');
  const branch = requested || view.branch;
  if (!branch) throw new Error('HEAD is detached. Check out a branch before pushing.');
  if (!SAFE_NAME.test(branch)) throw new Error('This branch name is unusual; push it from a terminal.');
  const [exists, configuredRemote, merge] = await Promise.all([
    runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], root),
    runGit(['config', '--get', `branch.${branch}.remote`], root),
    runGit(['config', '--get', `branch.${branch}.merge`], root)
  ]);
  if (exists.code !== 0) throw new Error(`There is no local branch named ${branch}.`);
  // "." as a branch's remote means it tracks another local branch, not a remote.
  const tracked = configuredRemote.stdout.trim();
  const hasUpstream = Boolean(tracked && tracked !== '.' && merge.stdout.trim());
  const remote = hasUpstream ? tracked : view.origin?.name;
  if (!remote) throw new Error('There is no remote to push to.');
  const target = hasUpstream ? merge.stdout.trim().replace(/^refs\/heads\//, '') : branch;
  if (![remote, target].every((name) => SAFE_NAME.test(name))) throw new Error('This branch or remote name is unusual; push it from a terminal.');
  await checkRemote?.(view.remotes.find((candidate) => candidate.name === remote) || null);

  const args = [...authArgs, 'push', '--porcelain', ...(hasUpstream ? [] : ['--set-upstream']), remote, `refs/heads/${branch}:refs/heads/${target}`];
  const result = await runGit(args, root, { captureErrors: true, timeoutMs: WRITE_TIMEOUT_MS });
  if (result.code !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    if (/\[rejected\]|non-fast-forward|fetch first/i.test(output)) {
      throw new Error('The remote has commits this Mac does not have. Pull them in a terminal (git pull), then push.');
    }
    if (/Permission to .* denied|403/i.test(output)) throw new Error('Your GitHub account cannot push to this repository.');
    if (/Repository not found/i.test(output)) throw new Error('GitHub says this repository does not exist, or your account cannot see it.');
    if (/Authentication failed|could not read Username/i.test(output)) throw new Error('GitHub rejected the gh session. Run gh auth login again.');
    throw new Error(result.timedOut ? 'The push took too long.' : `Push failed: ${lastLines(result.stderr) || 'git push failed.'}`);
  }
  return overview(root);
}

// Asks the remote itself which commits it has (git ls-remote), which is exact
// where remote-tracking branches are only as fresh as the last fetch. Nothing is
// written to the repository.
async function verifyRemote(root, view, { authArgs, timeoutMs = 20_000 }) {
  const checkedAt = new Date().toISOString();
  const remote = view.upstream?.remote || view.origin?.name;
  if (!remote || !SAFE_NAME.test(remote)) return { ok: false, checkedAt, error: 'No remote to check.' };
  const listed = await runGit([...authArgs, 'ls-remote', '--heads', remote], root, { captureErrors: true, timeoutMs });
  if (listed.code !== 0) {
    const error = listed.timedOut ? 'The remote did not answer in time.'
      : /Repository not found|not found/i.test(listed.stderr) ? 'The remote repository does not exist, or your account cannot see it.'
        : /Authentication failed|could not read Username/i.test(listed.stderr) ? 'The remote refused the gh session.'
          : `Could not reach the remote: ${lastLines(listed.stderr, 2) || 'git ls-remote failed.'}`;
    return { ok: false, checkedAt, remote, error };
  }
  const heads = new Map();
  for (const line of listed.stdout.split('\n')) {
    const [hash, ref] = line.split('\t');
    if (hash && ref?.startsWith('refs/heads/')) heads.set(ref.slice('refs/heads/'.length), hash);
  }
  const branch = view.upstream?.branch || view.branch;
  const remoteHash = branch ? heads.get(branch) || null : null;
  const known = remoteHash ? (await runGit(['cat-file', '-e', `${remoteHash}^{commit}`], root)).code === 0 : false;
  const hashes = [...new Set(heads.values())];
  // Commits on local branches that no remote has: not in this remote's live
  // branch tips, and not in any other remote's tracking branches (a second
  // remote counts as a copy too). Tips this Mac has never fetched are skipped
  // (--ignore-missing).
  const otherRemotes = view.remotes
    .filter((candidate) => candidate.name !== remote && SAFE_NAME.test(candidate.name))
    .map((candidate) => `--remotes=${candidate.name}`);
  const localOnly = hashes.length <= 2000
    ? await runGit(['rev-list', '--count', '--ignore-missing', '--branches', '--not', ...otherRemotes, ...hashes], root, { timeoutMs: 20_000 })
    : null;
  let ahead = 0;
  let behind = 0;
  if (view.head && remoteHash && known) {
    const [mine, theirs] = await Promise.all([
      runGit(['rev-list', '--count', view.head, '--not', remoteHash], root),
      runGit(['rev-list', '--count', remoteHash, '--not', view.head], root)
    ]);
    ahead = Number(mine.stdout.trim()) || 0;
    behind = Number(theirs.stdout.trim()) || 0;
  }
  return {
    ok: true,
    checkedAt,
    remote,
    branch,
    branchOnRemote: Boolean(remoteHash),
    inSync: Boolean(remoteHash) && remoteHash === view.head,
    ahead,
    behind,
    // The remote's tip is a commit this Mac has never seen: it has new work.
    remoteHasUnknownCommits: Boolean(remoteHash) && !known,
    localOnlyCommits: localOnly && localOnly.code === 0 ? Number(localOnly.stdout.trim()) || 0 : null
  };
}

// The older summary shape the cleanup review reads, built from overview().
async function repositorySummary(root) {
  const view = await overview(root);
  if (view.state !== 'repository') return { path: root, readable: false };
  return {
    path: root,
    readable: true,
    branch: view.branch,
    changes: view.changes.total,
    ahead: view.ahead,
    remotes: view.remotes.length,
    origin: view.origin,
    localOnlyCommits: view.localOnlyCommits,
    stashes: view.stashes,
    lastFetchAt: view.lastFetchAt
  };
}

module.exports = {
  commitAll,
  commitWarnings,
  describeRemote,
  details,
  locate,
  overview,
  parseStatus,
  pathStatus,
  push,
  redactUrl,
  repositorySummary,
  verifyRemote
};
