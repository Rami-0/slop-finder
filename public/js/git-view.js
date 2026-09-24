import { api } from './api.js';
import { element, icon } from './dom.js';
import { basename, plural, relativeTime, tildify } from './format.js';

const BATCH_SIZE = 60;
const LEVEL_ICONS = { saved: 'check', 'at-risk': 'alert', unknown: 'branch' };

/**
 * Whether deleting this project could lose work, as far as Git can tell. The
 * answer colors the git column and heads the Git dialog. The facts behind it
 * are always shown as text, whatever this returns.
 *
 * `git` is what the server reports for a project (lib/git.js, overview()):
 *   state             'repository' | 'inside' (part of a repository above it)
 *                     | 'none' (no Git at all) | 'unreadable'
 *   remotes           [{ name, host, slug, url, local }]; local = a folder on this computer
 *   origin            the remote the current branch pushes to (or null)
 *   hasCommits        false for a repository with no commits yet
 *   changes           { total, staged, unstaged, untracked, conflicted } uncommitted work
 *   localOnlyCommits  commits on local branches that no remote-tracking branch has
 *   stashes           stashed changes (stashes are never pushed)
 *   behind            commits the upstream has that were never pulled here
 *   lastFetchAt       when remote-tracking branches were last updated (ISO, or null)
 *   verified          null, or the remote's own answer from the last check in the
 *                     Git dialog: { ok, checkedAt, inSync, branchOnRemote,
 *                     localOnlyCommits, remoteHasUnknownCommits, error }
 *
 * 'at-risk' means something exists only on this Mac; 'saved' means a remote
 * elsewhere has every commit; 'unknown' means neither can be shown.
 *
 * @returns {'saved' | 'at-risk' | 'unknown'}
 */
export function gitVerdict(git) {
  if (!git) return 'unknown';
  // No repository: nothing is versioned or pushed, so Git holds no copy at all.
  if (git.state === 'none') return 'at-risk';
  // 'inside' belongs to a repository this object does not describe; 'unreadable' says nothing.
  if (git.state !== 'repository') return 'unknown';
  // The remote's own answer beats remote-tracking branches, which are only as fresh as the last fetch.
  const verified = git.verified?.ok ? git.verified : null;
  const localOnly = verified?.localOnlyCommits ?? git.localOnlyCommits;
  // Work that exists only here: no remote, uncommitted changes (untracked and
  // conflicted files included), stashes, or commits that no remote has.
  if (!git.remotes?.length || git.changes?.total || git.stashes || localOnly > 0) return 'at-risk';
  // Nothing flagged, yet no copy Git can vouch for: an empty repository, commits
  // on a detached HEAD (localOnlyCommits counts branches only), or a remote that
  // is a folder on this computer.
  if (!git.hasCommits || git.detached || git.origin?.local) return 'unknown';
  // The live check failed (the remote may be gone), so stale remote-tracking
  // branches must not make the work look safe.
  if (git.verified && !git.verified.ok) return 'unknown';
  return 'saved';
}

export function remoteLabel(remote) {
  if (!remote) return 'no remote';
  if (remote.local) return 'a folder on this computer';
  return remote.slug ? `${remote.host}/${remote.slug}` : remote.url;
}

// The column is monospace, so a character budget is a width budget. What tells
// repositories apart is the last path segment (the repository name), so the
// owner or host before it is shortened first: "Add-T…/depository_back".
const ORIGIN_BUDGET = 22;
function compactPath(value) {
  if (value.length <= ORIGIN_BUDGET) return value;
  const cut = value.lastIndexOf('/');
  const room = ORIGIN_BUDGET - (value.length - cut) - 1;
  return cut > 0 && room >= 2 ? `${value.slice(0, room)}…${value.slice(cut)}` : `…${value.slice(cut)}`;
}

// Short enough for the git column: owner/repo on GitHub, host/path elsewhere.
function originShort(git) {
  if (git.state === 'none') return 'no repository';
  if (git.state === 'unreadable') return 'unreadable';
  if (!git.remotes?.length) return 'local only';
  if (git.origin?.local) return 'local folder';
  return compactPath(git.origin?.host === 'github.com' ? git.origin.slug : remoteLabel(git.origin));
}

function changeBreakdown(changes) {
  return [
    changes.staged && `${changes.staged} staged`,
    changes.unstaged && `${changes.unstaged} modified`,
    changes.untracked && `${changes.untracked} new`,
    changes.conflicted && `${changes.conflicted} in conflict`
  ].filter(Boolean).join(', ');
}

// How fresh the "is it on the remote" answer is.
export function freshness(git) {
  if (git.verified?.ok) return `checked with the remote ${relativeTime(git.verified.checkedAt)}`;
  return git.lastFetchAt ? `as of the last fetch, ${relativeTime(git.lastFetchAt)}` : 'never fetched, so the remote may differ';
}

// Plain facts about a project's Git state, most urgent first. `short` fits the
// git column; `text` is the full sentence for tooltips and the Git dialog.
export function gitFacts(git) {
  if (!git) return [];
  if (git.state === 'none') return [{ id: 'no-git', short: 'no git', text: 'Not in any Git repository, so nothing here is versioned or pushed anywhere.' }];
  if (git.state === 'inside') {
    return [{ id: 'inside', short: `in ${basename(git.root)}`, text: `Part of the Git repository at ${tildify(git.root)}.` }];
  }
  if (git.state !== 'repository') return [{ id: 'unreadable', short: 'unreadable', text: git.error || 'Git could not read this repository.' }];

  const facts = [];
  const add = (id, short, text) => facts.push({ id, short, text });
  const verified = git.verified?.ok ? git.verified : null;
  const localOnly = verified?.localOnlyCommits ?? git.localOnlyCommits;
  if (!git.remotes.length) {
    add('no-remote', 'no remote', git.hasCommits
      ? `No remote: all ${plural(git.localOnlyCommits, 'commit')} exist only on this Mac.`
      : 'No remote and no commits yet.');
  }
  if (git.changes.conflicted) add('conflicts', `${git.changes.conflicted} conflicts`, `${plural(git.changes.conflicted, 'file')} with merge conflicts.`);
  if (git.changes.total) add('changes', `${git.changes.total} uncommitted`, `${plural(git.changes.total, 'uncommitted change')} (${changeBreakdown(git.changes)}).`);
  if (git.remotes.length && localOnly) {
    add('unpushed', `${localOnly} unpushed`, `${plural(localOnly, 'commit')} that no remote has (${freshness(git)}).`);
  }
  if (git.stashes) add('stashes', `${git.stashes} stashed`, `${plural(git.stashes, 'stash', 'stashes')}. Stashes are never pushed.`);
  if (git.origin?.local) {
    add('local-remote', 'local remote', `The remote "${git.origin.name}" is a folder on this computer (${git.origin.url}), a backup only if it is on another drive.`);
  }
  if (git.detached) add('detached', 'detached', 'HEAD is detached: commits made here belong to no branch.');
  if (git.verified && !git.verified.ok) add('check-failed', 'check failed', `The last check with the remote failed: ${git.verified.error}`);
  if (verified?.remoteHasUnknownCommits) add('remote-ahead', 'remote ahead', 'The remote has commits this Mac has never fetched.');
  else if (git.behind) add('behind', `${git.behind} behind`, `${git.upstream.name} has ${plural(git.behind, 'commit')} this Mac has not pulled.`);
  if (verified && !verified.branchOnRemote && git.branch) add('branch-missing', 'branch not on remote', `The branch ${git.branch} does not exist on the remote.`);
  else if (!verified && git.remotes.length && git.branch && !git.upstream) add('no-upstream', 'no upstream', `${git.branch} does not track a remote branch.`);
  if (!git.hasCommits && git.remotes.length) add('no-commits', 'no commits', 'No commits yet.');
  if (!facts.length) add('synced', 'synced', `Clean, and every commit is on ${remoteLabel(git.origin)} (${freshness(git)}).`);
  return facts;
}

function stop(handler) {
  return (event) => {
    event.stopPropagation();
    handler();
  };
}

// The git column: a verdict-colored chip with the most urgent fact and where the
// code lives. Deleted projects show the remote they had when last seen.
export function renderGitCell(cell, project, git, { onOpen }) {
  cell.replaceChildren();
  if (project.status === 'missing') {
    const origin = git?.origin;
    if (!origin) {
      cell.append(element('span', { className: 'git-muted', text: git?.state === 'repository' ? 'had no remote' : '—' }));
      return;
    }
    const chip = element('button', {
      className: 'git-chip is-gone',
      title: `When last seen, this project pushed to ${remoteLabel(origin)}. Open for the clone command.`,
      attrs: { type: 'button', 'aria-label': `Git history of ${project.name}` }
    }, [element('span', { className: 'git-line', text: 'was on' }), element('span', { className: 'git-origin', text: originShort(git) })]);
    chip.addEventListener('click', stop(() => onOpen(project)));
    cell.append(chip);
    return;
  }
  if (!git) {
    cell.append(element('span', { className: 'git-muted is-pending', text: 'checking…' }));
    return;
  }
  const facts = gitFacts(git);
  if (git.state === 'inside') {
    cell.append(element('span', { className: 'git-muted', text: facts[0].short, title: facts[0].text }));
    return;
  }
  const level = gitVerdict(git);
  const extra = facts.length > 1 ? ` +${facts.length - 1}` : '';
  const where = git.origin ? `${git.origin.name}: ${remoteLabel(git.origin)}\n` : '';
  const chip = element('button', {
    className: `git-chip is-${level}`,
    title: `${where}${facts.map((fact) => fact.text).join('\n')}\n\nClick for details${git.state === 'repository' ? ', commit, and push' : ''}.`,
    attrs: { type: 'button', 'aria-label': `Git: ${facts.map((fact) => fact.short).join(', ')}. Open details for ${project.name}` }
  }, [
    element('span', { className: 'git-line' }, [icon(LEVEL_ICONS[level] || 'branch'), element('span', { text: `${facts[0].short}${extra}` })]),
    element('span', { className: 'git-origin', text: originShort(git) })
  ]);
  chip.addEventListener('click', stop(() => onOpen(project)));
  cell.append(chip);
}

// Fresh Git state for every present project, fetched in the background a batch
// at a time. Until an answer arrives, the snapshot saved in the inventory stands.
export function createGitLoader({ onUpdate, onError }) {
  const live = new Map();
  let generation = 0;

  async function refresh(projects) {
    const current = ++generation;
    const paths = projects.filter((project) => project.status !== 'missing').map((project) => project.path);
    for (let index = 0; index < paths.length; index += BATCH_SIZE) {
      try {
        const { items } = await api.gitOverview(paths.slice(index, index + BATCH_SIZE));
        if (current !== generation) return;
        for (const [path, git] of Object.entries(items)) live.set(path, git);
        onUpdate();
      } catch (error) {
        if (current === generation) onError?.(error);
        return;
      }
    }
  }

  return {
    refresh,
    get: (project) => (project.status === 'missing' ? project.git : live.get(project.path) ?? project.git) ?? null,
    set(path, git) {
      live.set(path, git);
      onUpdate();
    }
  };
}
