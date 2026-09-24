import test from 'node:test';
import assert from 'node:assert/strict';
import { gitFacts, gitVerdict } from '../public/js/git-view.js';

const GITHUB = { name: 'origin', url: 'https://github.com/owner/repo.git', host: 'github.com', slug: 'owner/repo', web: 'https://github.com/owner/repo', local: false };
const FOLDER = { name: 'backup', url: '/Volumes/Backup/repo.git', host: null, slug: null, web: null, local: true };
const CLEAN = { total: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0 };
// What verifyRemote() answers when the branch is exactly on the remote, and when the remote is gone.
const IN_SYNC = { ok: true, checkedAt: '2026-09-24T10:00:00.000Z', remote: 'origin', branch: 'main', branchOnRemote: true, inSync: true, ahead: 0, behind: 0, remoteHasUnknownCommits: false, localOnlyCommits: 0 };
const FAILED = { ok: false, checkedAt: '2026-09-24T10:00:00.000Z', remote: 'origin', error: 'The remote repository does not exist, or your account cannot see it.' };

// A clean repository with every commit on GitHub, as overview() reports it.
function repository(overrides = {}) {
  const head = '0123456789abcdef0123456789abcdef01234567';
  return {
    state: 'repository',
    root: '/Users/someone/code/app',
    checkedAt: '2026-09-24T09:00:00.000Z',
    branch: 'main',
    detached: false,
    head,
    hasCommits: true,
    upstream: { name: 'origin/main', remote: 'origin', branch: 'main' },
    ahead: 0,
    behind: 0,
    localOnlyCommits: 0,
    changes: { ...CLEAN },
    stashes: 0,
    remotes: [GITHUB],
    origin: GITHUB,
    lastCommit: { hash: head, at: '2026-09-23T12:00:00.000Z', subject: 'first' },
    lastFetchAt: '2026-09-24T08:00:00.000Z',
    verified: null,
    ...overrides
  };
}

// Each case is one step away from the synced repository: what changed, and the verdict it earns.
const CASES = [
  ['clean, and every commit is on the remote', {}, 'saved'],
  // Work that exists only on this Mac.
  ['no remote', { remotes: [], origin: null }, 'at-risk'],
  ['a modified file', { changes: { ...CLEAN, total: 1, unstaged: 1 } }, 'at-risk'],
  ['an untracked file', { changes: { ...CLEAN, total: 1, untracked: 1 } }, 'at-risk'],
  ['a merge conflict', { changes: { ...CLEAN, total: 1, conflicted: 1 } }, 'at-risk'],
  ['a stash', { stashes: 1 }, 'at-risk'],
  ['commits the last fetch showed as unpushed', { localOnlyCommits: 2 }, 'at-risk'],
  ['commits the remote itself says it lacks', { verified: { ...IN_SYNC, inSync: false, ahead: 2, localOnlyCommits: 2 } }, 'at-risk'],
  ['a failed check does not hide what the last fetch showed as unpushed', { localOnlyCommits: 2, verified: FAILED }, 'at-risk'],
  // Nothing flagged, but no copy Git can vouch for.
  ['no commits yet', { hasCommits: false, head: null, lastCommit: null }, 'unknown'],
  ['a detached HEAD', { detached: true, branch: null, upstream: null }, 'unknown'],
  ['a remote that is a folder on this computer', { remotes: [FOLDER], origin: FOLDER }, 'unknown'],
  ['a failed check with the remote', { verified: FAILED }, 'unknown'],
  // The remote already has everything this Mac has, so these stay saved.
  ['behind the upstream', { behind: 3 }, 'saved'],
  ['the remote has commits never fetched here', { verified: { ...IN_SYNC, inSync: false, behind: 3, remoteHasUnknownCommits: true } }, 'saved'],
  ['the branch is not on the remote yet, but its commits are', { verified: { ...IN_SYNC, branchOnRemote: false, inSync: false } }, 'saved'],
  ['no upstream', { upstream: null }, 'saved'],
  ['never fetched', { lastFetchAt: null }, 'saved'],
  // The remote's own answer beats the remote-tracking branches.
  ['the remote confirms commits a stale fetch called unpushed', { localOnlyCommits: 4, verified: IN_SYNC }, 'saved'],
  ['the remote could not count, so the last fetch stands', { localOnlyCommits: 4, verified: { ...IN_SYNC, localOnlyCommits: null } }, 'at-risk']
];

// The facts that name work existing only here. The column paints only 'at-risk'
// red, so no other verdict may sit above one of these.
const LOSS_FACTS = new Set(['no-remote', 'conflicts', 'changes', 'unpushed', 'stashes']);

test('tells saved, at-risk, and unknown apart one fact at a time', () => {
  for (const [name, overrides, expected] of CASES) assert.equal(gitVerdict(repository(overrides)), expected, name);
});

test('judges only a repository it describes', () => {
  assert.equal(gitVerdict(null), 'unknown');
  assert.equal(gitVerdict(undefined), 'unknown');
  assert.equal(gitVerdict({ state: 'none', checkedAt: '2026-09-24T09:00:00.000Z' }), 'at-risk', 'no repository means no copy anywhere');
  assert.equal(gitVerdict({ state: 'inside', root: '/Users/someone/code' }), 'unknown', 'the enclosing repository is not described here');
  assert.equal(gitVerdict({ state: 'unreadable', root: '/Users/someone/code/app', error: 'Git could not read this repository.' }), 'unknown');
  assert.equal(gitVerdict({ state: 'missing' }), 'unknown', 'anything unexpected');
});

test('answers for inventory snapshots that lack newer fields', () => {
  assert.equal(gitVerdict({ state: 'repository' }), 'at-risk', 'no remotes recorded');
  assert.equal(gitVerdict({ state: 'repository', remotes: [GITHUB], origin: GITHUB, hasCommits: true }), 'saved');
});

test('the verdict never contradicts the facts shown under it', () => {
  for (const [name, overrides, expected] of CASES) {
    const listed = gitFacts(repository(overrides)).filter((fact) => LOSS_FACTS.has(fact.id)).map((fact) => fact.id);
    if (expected === 'at-risk') assert.ok(listed.length, `${name}: at-risk, but no fact names the work at stake`);
    else assert.deepEqual(listed, [], `${name}: ${expected}, but a fact names work at stake`);
  }
});
