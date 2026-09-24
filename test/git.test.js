const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Git must not pick up the machine's own settings (signing, hooks, credential
// helpers), and commits need an identity. lib/git.js copies the environment
// when it loads, so this comes first.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com'
});

const git = require('../lib/git');
const github = require('../lib/github');
const safety = require('../lib/safety');
const { snapshot } = require('../lib/repos');

function run(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

async function write(file, content = 'x') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

async function tempDir(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'slop-git-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

// A working repository cloned from a bare "remote" in the same temp folder.
async function clonedFixture(t) {
  const dir = await tempDir(t);
  const remote = path.join(dir, 'remote.git');
  const work = path.join(dir, 'work');
  run(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  run(dir, 'clone', '-q', remote, work);
  await write(path.join(work, '.gitignore'), 'node_modules/\n');
  await write(path.join(work, 'index.js'), 'one');
  run(work, 'add', '.');
  run(work, 'commit', '-qm', 'first');
  run(work, 'push', '-q', 'origin', 'main');
  return { dir, remote, work };
}

test('reads remotes without ever exposing credentials', () => {
  const token = git.describeRemote('origin', 'https://ghp_secret@github.com/owner/repo.git');
  assert.equal(token.url, 'https://github.com/owner/repo.git');
  assert.equal(token.slug, 'owner/repo');
  assert.equal(token.web, 'https://github.com/owner/repo');
  assert.ok(!JSON.stringify(git.describeRemote('o', 'https://user:pass@example.com/a/b')).includes('pass'));

  const scp = git.describeRemote('origin', 'git@github.com:owner/repo.git');
  assert.equal(scp.host, 'github.com');
  assert.equal(scp.slug, 'owner/repo');
  for (const local of ['/Volumes/Backup/repo.git', 'file:///srv/repo.git', '../sibling.git']) {
    assert.equal(git.describeRemote('backup', local).local, true, local);
  }
});

test('finds work that exists only on this machine', async (t) => {
  const dir = await tempDir(t);
  run(dir, 'init', '-q', '-b', 'main');
  await write(path.join(dir, 'a.js'));
  run(dir, 'add', '.');
  run(dir, 'commit', '-qm', 'one');
  await write(path.join(dir, 'b.js'));
  run(dir, 'add', '.');
  run(dir, 'commit', '-qm', 'two');
  await write(path.join(dir, 'a.js'), 'changed');
  await write(path.join(dir, 'new.js'));
  await write(path.join(dir, 'stashed.js'));
  run(dir, 'stash', 'push', '-q', '--include-untracked', '--', 'stashed.js');

  const view = await git.overview(dir);
  assert.equal(view.state, 'repository');
  assert.equal(view.branch, 'main');
  assert.equal(view.remotes.length, 0);
  assert.equal(view.localOnlyCommits, 2, 'with no remote, every commit exists only here');
  assert.deepEqual([view.changes.unstaged, view.changes.untracked, view.changes.total], [1, 1, 2]);
  assert.equal(view.stashes, 1);
  assert.equal(view.lastCommit.subject, 'two');

  await fs.mkdir(path.join(dir, 'packages', 'app'), { recursive: true });
  assert.equal((await git.locate(path.join(dir, 'packages', 'app'))).state, 'inside');
  assert.equal((await git.locate(dir)).state, 'repository');
  const outside = await tempDir(t);
  assert.equal((await git.locate(outside)).state, 'none');
});

test('refuses commits that would publish rebuildable folders or oversized files, and flags secrets', async (t) => {
  const { work } = await clonedFixture(t);
  await write(path.join(work, '.venv', 'lib', 'site.py'));
  await write(path.join(work, '.env'), 'TOKEN=1');
  await write(path.join(work, '.env.example'), 'TOKEN=');
  const blocked = await git.details(work);
  assert.ok(blocked.warnings.some((warning) => warning.level === 'block' && warning.paths.includes('.venv/')));
  const secrets = blocked.warnings.find((warning) => /passwords, keys, or tokens/.test(warning.text));
  assert.deepEqual(secrets.paths, ['.env'], '.env.example is a template, not a secret');
  await assert.rejects(git.commitAll(work, { message: 'all', fingerprint: blocked.fingerprint }), /Rebuildable folders/);
  assert.equal(run(work, 'rev-list', '--count', 'HEAD'), '1', 'nothing was committed');
});

test('commits only the reviewed state, and only after warnings are confirmed', async (t) => {
  const { work } = await clonedFixture(t);
  await write(path.join(work, 'index.js'), 'two');
  await write(path.join(work, 'credentials.json'), '{}');
  const reviewed = await git.details(work);
  assert.equal(reviewed.fileCount, 2);

  await assert.rejects(git.commitAll(work, { message: 'save', fingerprint: reviewed.fingerprint }), /Confirm the warnings/);
  await write(path.join(work, 'surprise.js'));
  await assert.rejects(git.commitAll(work, { message: 'save', fingerprint: reviewed.fingerprint, acceptWarnings: true }), /different from what you reviewed/);
  await fs.rm(path.join(work, 'surprise.js'));
  await assert.rejects(git.commitAll(work, { message: '  ', fingerprint: reviewed.fingerprint, acceptWarnings: true }), /commit message/);

  const after = await git.commitAll(work, { message: 'save work', fingerprint: reviewed.fingerprint, acceptWarnings: true });
  assert.equal(after.changes.total, 0);
  assert.equal(after.ahead, 1);
  assert.equal(run(work, 'log', '-1', '--format=%s'), 'save work');
});

test('pushes fast-forward only, including a branch that is not checked out', async (t) => {
  const { dir, remote, work } = await clonedFixture(t);
  await write(path.join(work, 'index.js'), 'two');
  run(work, 'commit', '-qam', 'second');
  const pushed = await git.push(work, { authArgs: [] });
  assert.equal(pushed.ahead, 0);
  assert.equal(pushed.localOnlyCommits, 0);
  assert.equal(run(remote, 'rev-parse', 'main'), run(work, 'rev-parse', 'HEAD'));

  run(work, 'branch', 'feature');
  run(work, 'checkout', '-q', 'feature');
  await write(path.join(work, 'feature.js'));
  run(work, 'add', '.');
  run(work, 'commit', '-qm', 'feature work');
  run(work, 'checkout', '-q', 'main');
  assert.deepEqual((await git.details(work)).localOnlyBranches, ['feature']);
  let checked = null;
  await git.push(work, { authArgs: [], branch: 'feature', checkRemote: async (target) => { checked = target.name; } });
  assert.equal(checked, 'origin', 'the remote is checked before pushing');
  assert.equal(run(remote, 'rev-parse', 'feature'), run(work, 'rev-parse', 'feature'));
  assert.equal(run(work, 'config', '--get', 'branch.feature.remote'), 'origin', 'the new branch now tracks the remote');

  // Someone else pushes first: this push must be refused, never forced.
  const other = path.join(dir, 'other');
  run(dir, 'clone', '-q', remote, other);
  await write(path.join(other, 'theirs.js'));
  run(other, 'add', '.');
  run(other, 'commit', '-qm', 'theirs');
  run(other, 'push', '-q', 'origin', 'main');
  await write(path.join(work, 'mine.js'));
  run(work, 'add', '.');
  run(work, 'commit', '-qm', 'mine');
  const theirs = run(remote, 'rev-parse', 'main');
  await assert.rejects(git.push(work, { authArgs: [] }), /remote has commits this Mac does not have/);
  assert.equal(run(remote, 'rev-parse', 'main'), theirs, 'the remote keeps their commit');
  await assert.rejects(git.push(work, { authArgs: [], branch: '--force' }), /unusual/);
});

test('asks the remote itself what it has, counting every remote as a copy', async (t) => {
  const { dir, remote, work } = await clonedFixture(t);
  const view = await git.overview(work);
  const synced = await git.verifyRemote(work, view, { authArgs: [] });
  assert.equal(synced.ok, true);
  assert.equal(synced.inSync, true);
  assert.equal(synced.localOnlyCommits, 0);

  // A branch that only a second remote has is still a copy somewhere else.
  const backup = path.join(dir, 'backup.git');
  run(dir, 'init', '-q', '--bare', '-b', 'main', backup);
  run(work, 'remote', 'add', 'backup', backup);
  run(work, 'checkout', '-q', '-b', 'side');
  await write(path.join(work, 'side.js'));
  run(work, 'add', '.');
  run(work, 'commit', '-qm', 'side');
  run(work, 'push', '-q', 'backup', 'side');
  run(work, 'checkout', '-q', 'main');
  const withBackup = await git.verifyRemote(work, await git.overview(work), { authArgs: [] });
  assert.equal(withBackup.localOnlyCommits, 0);

  // New work on the remote that this machine never fetched.
  const other = path.join(dir, 'other');
  run(dir, 'clone', '-q', remote, other);
  await write(path.join(other, 'theirs.js'));
  run(other, 'add', '.');
  run(other, 'commit', '-qm', 'theirs');
  run(other, 'push', '-q', 'origin', 'main');
  const behind = await git.verifyRemote(work, await git.overview(work), { authArgs: [] });
  assert.equal(behind.inSync, false);
  assert.equal(behind.remoteHasUnknownCommits, true);
  assert.equal(run(work, 'rev-parse', 'origin/main'), view.head, 'checking the remote wrote nothing locally');
});

test('keeps a remote check in the inventory only while HEAD stays put', () => {
  const verified = { ok: true, inSync: true, checkedAt: 'then' };
  const previous = { state: 'repository', head: 'a', verified };
  assert.deepEqual(snapshot({ state: 'repository', head: 'a', files: [1], fingerprint: 'x' }, previous).verified, verified);
  assert.equal(snapshot({ state: 'repository', head: 'b' }, previous).verified, null);
  assert.ok(!('files' in snapshot({ state: 'repository', head: 'a', files: [1] }, previous)), 'file lists are not stored');
  assert.equal(snapshot({ state: 'missing' }, previous), previous, 'a vanished folder keeps its last known state');
});

test('borrows the gh session per command without exposing where gh lives', () => {
  const status = { ready: true, ghPath: "/opt/it's here/gh", hosts: ['github.com'], login: 'someone' };
  const args = github.gitAuthArgs(status);
  assert.deepEqual(args.slice(0, 4), ['-c', 'credential.https://github.com.helper=', '-c', `credential.https://github.com.helper=!'/opt/it'\\''s here/gh' auth git-credential`]);
  assert.ok(args.includes('url.https://github.com/.insteadOf=git@github.com:'));
  assert.deepEqual(github.gitAuthArgs({ ready: false }), []);
  assert.ok(!('ghPath' in github.publicStatus(status)));
  assert.equal(github.canUseRemote(status, { host: 'github.com', local: false }), true);
  assert.equal(github.canUseRemote(status, { host: 'gitlab.com', local: false }), false);
});

test('allows the per-user temp folder by name, and never the rest of /private/var', async () => {
  const { builtin } = await safety.describeLocations();
  const tmp = builtin.find((location) => location.label === '$TMPDIR');
  assert.ok(tmp, '$TMPDIR is an allowed location');
  assert.equal(tmp.path, await fs.realpath(os.tmpdir()));
  if (process.platform === 'darwin') {
    assert.ok(!builtin.some((location) => location.path === '/private/var'));
    assert.match(safety.rootRejection('/private/var'), /System/);
    assert.match(safety.rootRejection('/private/var/folders'), /System/);
    // Siblings of the per-user T folder hold live caches and state for macOS services.
    const roots = builtin.map((location) => location.path);
    const cache = path.join(path.dirname(tmp.path), 'C', 'com.example.cache');
    assert.match(safety.protectionReason(cache, roots), /Outside the allowed locations/);
    assert.equal(safety.protectionReason(path.join(tmp.path, 'leftover-clone'), roots), null);
  }
});
