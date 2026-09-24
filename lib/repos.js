const path = require('node:path');
const git = require('./git');
const github = require('./github');
const { mapLimit } = require('./limit');
const safety = require('./safety');
const { readStore, writeStore, withStore } = require('./store');

// Git state for indexed projects, and the actions the page can run on them.
// Only folders in the inventory are accepted, and only the top folder of a
// repository can be committed or pushed.
const MAX_OVERVIEW_PATHS = 500;
const busy = new Set();

// What is kept in the inventory: enough to show, after a project is deleted,
// where its code lived and whether everything had been pushed.
function snapshot(view, previous) {
  if (!view || view.state === 'missing') return previous || null;
  const { files, fileCount, filesTruncated, fingerprint, warnings, localOnlyBranches, changesTruncated, ...kept } = view;
  // A check against the remote stays meaningful until HEAD moves.
  const verified = view.verified !== undefined
    ? view.verified
    : previous?.verified && previous.head === view.head ? previous.verified : null;
  return { ...kept, verified };
}

async function saveSnapshots(items) {
  const entries = Object.entries(items);
  if (!entries.length) return;
  await withStore(async () => {
    const store = await readStore();
    let changed = false;
    for (const project of store.projects) {
      if (project.status === 'missing' || !items[project.path]) continue;
      project.git = items[project.path];
      changed = true;
    }
    if (changed) await writeStore(store);
  });
}

async function indexedProject(target) {
  if (!safety.isNormalizedAbsolute(target)) throw new Error('Choose a project from the index.');
  const store = await readStore();
  const project = store.projects.find((candidate) => candidate.path === target);
  if (!project) throw new Error('That folder is not in the index. Scan again.');
  return project;
}

// Fresh local Git state for many projects at once. The page asks for every
// present project after loading; each answer is also saved to the inventory.
async function overviews(paths) {
  const requested = Array.isArray(paths) ? paths.filter((target) => typeof target === 'string') : [];
  if (requested.length > MAX_OVERVIEW_PATHS) throw new Error(`Ask for at most ${MAX_OVERVIEW_PATHS} projects at a time.`);
  const store = await readStore();
  const present = new Map(store.projects.filter((project) => project.status !== 'missing').map((project) => [project.path, project]));
  const wanted = [...new Set(requested)].filter((target) => present.has(target));
  const results = await mapLimit(wanted, 4, async (target) => [target, await git.locate(target)]);
  const items = {};
  for (const [target, view] of results) {
    if (view.state !== 'missing') items[target] = snapshot(view, present.get(target).git);
  }
  await saveSnapshots(items);
  return { items };
}

function suggestedName(root) {
  return path.basename(root).replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'project';
}

// Which actions the page may offer, and why not when it may not. Every action
// needs a signed-in gh; without it the page hides them and shows the reason.
function actionsFor(view, verified, repo, gh) {
  if (!gh.ready) return { available: false, reason: gh.reason };
  const origin = view.origin;
  const commit = !view.fileCount
    ? { allowed: false, reason: 'Nothing to commit.' }
    : view.changes.conflicted ? { allowed: false, reason: 'Resolve the merge conflicts first.' } : { allowed: true };

  let push;
  if (!view.remotes.length) push = { allowed: false, reason: 'No remote yet.' };
  else if (!github.canUseRemote(gh, origin)) {
    push = { allowed: false, reason: origin.local ? 'The remote is a folder on this computer, so gh cannot push there.' : `The remote is on ${origin.host}, where gh is not signed in.` };
  } else if (repo && !repo.found) push = { allowed: false, reason: repo.error };
  else if (repo && !repo.canPush) {
    push = { allowed: false, reason: repo.archived ? 'The repository is archived on GitHub.' : `${gh.login} has ${String(repo.permission || 'no').toLowerCase()} access here, so it cannot push.` };
  } else if (!view.hasCommits) push = { allowed: false, reason: 'No commits yet.' };
  else if (view.detached) push = { allowed: false, reason: 'HEAD is detached. Check out a branch first.' };
  else if (verified?.ok && (verified.remoteHasUnknownCommits || verified.behind)) {
    push = { allowed: false, reason: 'The remote has commits this Mac does not have. Pull them in a terminal first.' };
  } else {
    const newBranch = verified?.ok ? !verified.branchOnRemote : !view.upstream;
    const commits = verified?.ok ? verified.ahead : view.ahead;
    push = newBranch || commits
      ? { allowed: true, commits, newBranch, target: `${view.upstream?.remote || origin.name}/${view.upstream?.branch || view.branch}` }
      : { allowed: false, reason: 'Already up to date.' };
  }

  const create = view.remotes.length
    ? { allowed: false, reason: 'Already has a remote.' }
    : !view.hasCommits ? { allowed: false, reason: 'Commit something first.' } : { allowed: true, owner: gh.login, name: suggestedName(view.root) };
  // Other local branches whose commits no remote has. Each push is checked again
  // on the server against the remote that branch actually uses.
  const otherBranches = github.canUseRemote(gh, origin) && repo?.canPush !== false
    ? (view.localOnlyBranches || []).filter((name) => name !== view.branch)
    : [];
  return { available: true, login: gh.login, commit, push, create, otherBranches };
}

// Everything the Git dialog shows: the full local state and changed files, plus,
// when gh can reach the remote, what the remote really has and the account's
// permission there.
async function details(target) {
  const project = await indexedProject(target);
  const gh = await github.status();
  const ghPublic = github.publicStatus(gh);
  if (project.status === 'missing') return { path: target, missing: true, snapshot: project.git || null, gh: ghPublic };
  const located = await git.locate(target);
  if (located.state !== 'repository') {
    if (located.state !== 'missing') await saveSnapshots({ [target]: snapshot(located, project.git) });
    return { path: target, ...located, gh: ghPublic, actions: { available: false } };
  }
  const view = await git.details(located.root);
  let verified = null;
  let repo = null;
  if (view.state === 'repository' && github.canUseRemote(gh, view.origin)) {
    [verified, repo] = await Promise.all([
      git.verifyRemote(view.root, view, { authArgs: github.gitAuthArgs(gh) }),
      github.repoInfo(gh, view.origin)
    ]);
  }
  await saveSnapshots({ [target]: snapshot({ ...view, verified }, project.git) });
  return { path: target, ...view, verified, repo, gh: ghPublic, actions: view.state === 'repository' ? actionsFor(view, verified, repo, gh) : { available: false } };
}

async function readyGh() {
  const gh = await github.status();
  if (!gh.ready) throw new Error(gh.reason || 'gh is not signed in.');
  return gh;
}

// One Git action per repository at a time, so a double click cannot commit or
// push twice.
async function exclusive(target, task) {
  const project = await indexedProject(target);
  if (project.status === 'missing') throw new Error('This project is no longer on disk.');
  const located = await git.locate(target);
  if (located.state !== 'repository') throw new Error('Only the top folder of a Git repository can be committed or pushed.');
  if (busy.has(located.root)) throw new Error('Another Git action is still running for this repository.');
  busy.add(located.root);
  try {
    await task(located.root, located);
  } finally {
    busy.delete(located.root);
  }
  return details(target);
}

function commit({ path: target, message, fingerprint, acceptWarnings } = {}) {
  return readyGh().then(() => exclusive(target, (root) =>
    git.commitAll(root, { message, fingerprint, acceptWarnings: acceptWarnings === true })));
}

// Pushes the current branch, or `branch` when the page names another local one.
// Whichever remote that branch pushes to must be one gh is signed in to.
function push({ path: target, branch } = {}) {
  return readyGh().then((gh) => exclusive(target, (root) => git.push(root, {
    authArgs: github.gitAuthArgs(gh),
    branch: typeof branch === 'string' && branch ? branch : null,
    checkRemote: async (remote) => {
      if (!github.canUseRemote(gh, remote)) throw new Error('gh can only push to GitHub remotes it is signed in to.');
      const info = await github.repoInfo(gh, remote);
      if (info?.found && !info.canPush) throw new Error('Your GitHub account cannot push to this repository.');
    }
  })));
}

function createRemote({ path: target, name, visibility } = {}) {
  return readyGh().then((gh) => exclusive(target, async (root, view) => {
    if (view.remotes.length) throw new Error('This repository already has a remote.');
    if (!view.hasCommits) throw new Error('Commit something before creating the GitHub repository.');
    await github.createRepo(gh, root, { name, visibility });
  }));
}

module.exports = { actionsFor, commit, createRemote, details, overviews, push, snapshot };
