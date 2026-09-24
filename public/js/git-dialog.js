import { api } from './api.js';
import { $, element, icon } from './dom.js';
import { plural, relativeTime, tildify } from './format.js';
import { freshness, gitFacts, gitVerdict, remoteLabel } from './git-view.js';

const LEVEL_ICONS = { saved: 'check', 'at-risk': 'alert', unknown: 'info' };
const VERDICT_TEXT = {
  saved: 'Safe to delete as far as Git can tell: the work also lives on a remote.',
  'at-risk': 'Deleting this would lose work that exists only on this Mac.',
  unknown: 'No verdict yet. gitVerdict() in public/js/git-view.js decides this.'
};
const FILE_KINDS = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' };

function shellArg(value) {
  return /^[\w./~-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function link(text, href) {
  return href ? element('a', { text, attrs: { href, target: '_blank', rel: 'noopener noreferrer' } }) : element('span', { text });
}

// Everything Git knows about one project, what the remote really has, and the
// commit / push / create actions, which run through the gh session.
export function createGitDialog({ notify, onChange, onGithubStatus }) {
  const el = {
    dialog: $('#git-dialog'),
    title: $('#git-title'),
    summary: $('#git-summary'),
    body: $('#git-body'),
    refresh: $('#git-refresh'),
    close: $('#git-close')
  };
  let session = null;

  async function open(project) {
    session = { project, data: null, busy: null, draft: '' };
    el.title.textContent = project.name;
    el.summary.textContent = tildify(project.path);
    if (!el.dialog.open) el.dialog.showModal();
    await load(session);
  }

  async function load(current) {
    el.body.replaceChildren(element('div', { className: 'dialog-loading' }, [
      icon('refresh'),
      element('p', { text: 'Reading Git state and asking the remote what it has…' })
    ]));
    try {
      const data = await api.gitDetails(current.project.path);
      if (data.gh) onGithubStatus?.(data.gh);
      if (!data.missing && data.state) onChange(current.project.path, data);
      if (session !== current) return;
      current.data = data;
      render();
    } catch (error) {
      if (session === current) el.body.replaceChildren(element('p', { className: 'browser-error', text: error.message }));
    }
  }

  function render() {
    const { data } = session;
    if (data.missing) {
      renderMissing(data);
      return;
    }
    const sections = [verdictBlock(data, gitVerdict(data))];
    if (data.state === 'repository') {
      sections.push(factsTable(data));
      if (data.fileCount) sections.push(changesBlock(data));
      sections.push(actionsBlock(data));
    }
    el.body.replaceChildren(...sections);
  }

  function verdictBlock(git, level, heading = VERDICT_TEXT[level]) {
    return element('section', { className: `git-verdict is-${level}` }, [
      element('p', { className: 'git-verdict-head' }, [icon(LEVEL_ICONS[level]), element('span', { text: heading })]),
      element('ul', { className: 'git-facts' }, gitFacts(git).map((fact) => element('li', { text: fact.text })))
    ]);
  }

  function syncText(git) {
    if (!git.remotes.length) return 'No remote, so there is nothing to compare with.';
    const verified = git.verified;
    if (verified?.ok) {
      const where = `${verified.remote}/${verified.branch}`;
      if (!verified.branchOnRemote) return `${git.branch} is not on ${verified.remote} yet (checked ${relativeTime(verified.checkedAt)}).`;
      if (verified.inSync) return `In sync with ${where} (checked ${relativeTime(verified.checkedAt)}).`;
      const parts = [
        verified.ahead && `${plural(verified.ahead, 'commit')} to push`,
        verified.remoteHasUnknownCommits ? 'the remote has commits this Mac never fetched' : verified.behind && `${plural(verified.behind, 'commit')} to pull`
      ].filter(Boolean);
      return `${parts.join(', ') || 'Different from the remote'} against ${where} (checked ${relativeTime(verified.checkedAt)}).`;
    }
    const local = git.upstream
      ? `${git.ahead} ahead and ${git.behind} behind ${git.upstream.name}, ${freshness(git)}.`
      : `${git.branch || 'HEAD'} does not track a remote branch.`;
    return verified ? `${local} The live check failed: ${verified.error}` : local;
  }

  function remoteRow(remote, repo, named) {
    const parts = [link(remoteLabel(remote), remote.web)];
    if (named) parts.unshift(element('span', { className: 'git-dim', text: `${remote.name}: ` }));
    if (repo && remote.name === session.data.origin?.name) {
      if (!repo.found) parts.push(element('span', { className: 'git-dim', text: ` · ${repo.error}` }));
      else {
        parts.push(' ', element('span', { className: `badge ${repo.visibility === 'public' ? 'badge-warn' : ''}`, text: repo.visibility }));
        parts.push(' ', element('span', {
          className: `badge ${repo.canPush ? 'badge-accent' : ''}`,
          text: repo.canPush ? 'you can push' : repo.archived ? 'archived' : `${String(repo.permission || 'no').toLowerCase()} access`
        }));
      }
    }
    return element('div', {}, parts);
  }

  function factsTable(git) {
    const rows = [];
    const row = (label, ...value) => rows.push(element('dt', { text: label }), element('dd', {}, value));
    const where = git.detached ? `detached at ${git.head.slice(0, 7)}` : git.branch;
    row('repository', tildify(git.root), where ? element('span', { className: 'git-dim', text: ` · ${where}` }) : '');
    // The remote the branch pushes to comes first; names only matter when there are several.
    const remotes = [...git.remotes].sort((a, b) => Number(b.name === git.origin?.name) - Number(a.name === git.origin?.name));
    row(remotes.length > 1 ? 'remotes' : 'remote', ...(remotes.length
      ? remotes.map((remote) => remoteRow(remote, git.repo, remotes.length > 1))
      : [element('span', { className: 'git-danger', text: 'none: the history exists only on this Mac' })]));
    row('sync', syncText(git));
    if (git.lastCommit) {
      row('last commit', element('code', { text: git.lastCommit.hash.slice(0, 7) }), ` ${git.lastCommit.subject} `,
        element('span', { className: 'git-dim', text: `· ${relativeTime(git.lastCommit.at)}` }));
    }
    row('working tree', git.changes.total ? plural(git.changes.total, 'uncommitted change') : 'clean');
    if (git.stashes) row('stashes', `${git.stashes} (never pushed)`);
    if (git.localOnlyBranches?.length) row('local-only', git.localOnlyBranches.join(', '));
    return element('dl', { className: 'git-table' }, rows);
  }

  function changesBlock(git) {
    const files = git.files.map((file) => {
      const code = file.untracked ? '??' : file.conflicted ? 'U' : file.xy[0] !== '.' ? file.xy[0] : file.xy[1];
      const kind = file.untracked ? 'new' : file.conflicted ? 'conflict' : FILE_KINDS[code] || code;
      const staged = !file.untracked && !file.conflicted && file.xy[0] !== '.';
      return element('li', { className: `git-file is-${kind.replace(' ', '-')}`, title: `${kind}${staged ? ', staged' : ''}` }, [
        element('span', { className: 'git-file-code', text: code }),
        element('span', { className: 'git-file-path', text: file.from ? `${file.from} → ${file.path}` : file.path })
      ]);
    });
    const more = git.fileCount - git.files.length;
    return element('details', { className: 'git-changes', attrs: { open: git.fileCount <= 30 } }, [
      element('summary', { text: `${plural(git.fileCount, 'changed file')}${git.changes.untracked ? ', new folders listed file by file' : ''}` }),
      element('ul', {}, files),
      more > 0 ? element('p', { className: 'git-dim', text: `…and ${more.toLocaleString('en-US')} more` }) : null
    ]);
  }

  function reason(action, text) {
    return element('p', { className: 'git-reason' }, [element('strong', { text: action }), ` · ${text}`]);
  }

  function actionsBlock(git) {
    const actions = git.actions;
    const section = element('section', { className: 'git-actions' });
    if (!actions?.available) {
      const retry = element('button', { className: 'row-action', text: 'check again', attrs: { type: 'button' } });
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        try {
          onGithubStatus?.(await api.githubStatus(true));
        } catch {}
        load(session);
      });
      section.append(element('div', { className: 'notice git-gh-notice' }, [
        icon('alert'),
        element('span', { text: `Commit, push, and GitHub actions are hidden. ${git.gh?.reason || 'The GitHub CLI is not ready.'}` }),
        retry
      ]));
      return section;
    }
    section.append(element('h3', { text: `actions · through gh, signed in as ${actions.login}` }));
    if (actions.commit.allowed) section.append(commitForm(git));
    else if (git.fileCount) section.append(reason('commit', actions.commit.reason));
    if (actions.push.allowed) section.append(pushForm(git));
    else if (git.remotes.length) section.append(reason('push', actions.push.reason));
    if (actions.otherBranches?.length) section.append(branchesForm(actions.otherBranches));
    if (actions.create.allowed) section.append(createForm(git));
    else if (!git.remotes.length) section.append(reason('create on GitHub', actions.create.reason));
    return section;
  }

  function warningItem(warning) {
    const listed = warning.paths.length ? `: ${warning.paths.join(', ')}${warning.more ? ` and ${warning.more} more` : ''}` : '';
    return element('li', { className: warning.level === 'block' ? 'note-danger' : 'note-warn' }, [
      icon('alert'),
      element('span', { text: `${warning.text}${listed}` })
    ]);
  }

  function commitForm(git) {
    const warnings = git.warnings || [];
    const blocked = warnings.some((warning) => warning.level === 'block');
    const message = element('input', {
      attrs: { type: 'text', placeholder: 'commit message', 'aria-label': 'Commit message', maxlength: '4000', autocomplete: 'off', value: session.draft }
    });
    const accept = warnings.length && !blocked
      ? element('label', { className: 'toggle git-accept' }, [element('input', { attrs: { type: 'checkbox' } }), element('span', { text: 'I checked these files; commit them anyway' })])
      : null;
    const submit = element('button', { className: 'git-primary', text: `commit ${plural(git.fileCount, 'change')}`, attrs: { type: 'submit' } });
    const sync = () => {
      session.draft = message.value;
      submit.disabled = blocked || !message.value.trim() || Boolean(accept && !accept.querySelector('input').checked);
    };
    message.addEventListener('input', sync);
    accept?.querySelector('input').addEventListener('change', sync);
    sync();
    const form = element('form', { className: 'git-form' }, [
      element('p', { className: 'git-form-title', text: 'Commit every change listed above (git add --all, then git commit).' }),
      warnings.length ? element('ul', { className: 'review-notes' }, warnings.map(warningItem)) : null,
      element('div', { className: 'git-form-row' }, [message, submit]),
      accept
    ]);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      run('Committing…', 'Committed', () => api.gitCommit(session.project.path, {
        message: message.value,
        fingerprint: git.fingerprint,
        acceptWarnings: Boolean(accept?.querySelector('input').checked)
      }), () => {
        session.draft = '';
      });
    });
    return form;
  }

  function pushForm(git) {
    const push = git.actions.push;
    const label = push.newBranch
      ? `push ${git.branch} to ${push.target.split('/')[0]} as a new branch`
      : `push ${plural(push.commits, 'commit')} to ${push.target}`;
    const button = element('button', { className: 'git-primary', text: label, attrs: { type: 'button' } });
    button.addEventListener('click', () => run('Pushing…', 'Pushed', () => api.gitPush(session.project.path)));
    return element('div', { className: 'git-form' }, [
      git.repo?.visibility === 'public'
        ? element('p', { className: 'git-form-title git-warn', text: `${git.repo.nameWithOwner} is public: everyone can see what you push.` })
        : null,
      element('div', { className: 'git-form-row' }, [element('span', { className: 'git-form-note', text: 'fast-forward only, never a force-push' }), button])
    ]);
  }

  // Branches other than the checked-out one, with commits that no remote has.
  function branchesForm(branches) {
    return element('div', { className: 'git-form' }, [
      element('p', { className: 'git-form-title', text: `Other branches with commits that no remote has (${branches.length}):` }),
      element('div', { className: 'git-form-row' }, branches.map((branch) => {
        const button = element('button', { className: 'git-primary', text: `push ${branch}`, attrs: { type: 'button' } });
        button.addEventListener('click', () => run(`Pushing ${branch}…`, `Pushed ${branch}`, () => api.gitPush(session.project.path, branch)));
        return button;
      }))
    ]);
  }

  function createForm(git) {
    const create = git.actions.create;
    const name = element('input', { attrs: { type: 'text', value: create.name, 'aria-label': 'Repository name', autocomplete: 'off', spellcheck: 'false' } });
    const visibility = element('select', { attrs: { 'aria-label': 'Visibility' } }, [
      element('option', { text: 'private', attrs: { value: 'private' } }),
      element('option', { text: 'public', attrs: { value: 'public' } })
    ]);
    const submit = element('button', { className: 'git-primary', text: 'create on GitHub and push', attrs: { type: 'submit' } });
    const form = element('form', { className: 'git-form' }, [
      element('p', { className: 'git-form-title', text: `No remote yet. Create a GitHub repository for it under ${create.owner} (or my-org/name), add it as origin, and push:` }),
      element('div', { className: 'git-form-row' }, [name, visibility, submit])
    ]);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      run('Creating the repository…', 'Created on GitHub', () => api.githubCreate(session.project.path, { name: name.value.trim(), visibility: visibility.value }));
    });
    return form;
  }

  // Runs one action with every control disabled. The row updates even if the
  // dialog was closed meanwhile; after a failure the state is read again, since
  // part of the action (staging, for example) may have happened.
  async function run(progress, done, task, onSuccess) {
    if (session?.busy) return;
    const current = session;
    current.busy = progress;
    for (const control of el.body.querySelectorAll('button, input, select')) control.disabled = true;
    el.body.querySelector('.git-actions')?.append(element('p', { className: 'review-status is-running' }, [icon('refresh'), element('span', { text: progress })]));
    try {
      const data = await task();
      onChange(current.project.path, data);
      onSuccess?.();
      notify(`${done} · ${current.project.name}`);
      current.busy = null;
      if (session === current) {
        current.data = data;
        render();
      }
    } catch (error) {
      notify(error.message, true);
      current.busy = null;
      if (session === current) await load(current);
    }
  }

  function renderMissing(data) {
    const git = data.snapshot;
    const seen = git?.checkedAt ? `, as last seen ${relativeTime(git.checkedAt)}` : '';
    const blocks = [git
      ? verdictBlock(git, 'unknown', `This folder is gone. Its Git state${seen}:`)
      : element('p', { className: 'git-empty', text: 'This folder is gone, and no Git state was recorded for it.' })];
    const origin = git?.origin;
    if (origin && !origin.local) {
      const command = origin.host === 'github.com'
        ? `gh repo clone ${origin.slug} ${shellArg(data.path)}`
        : `git clone ${origin.url} ${shellArg(data.path)}`;
      const copy = element('button', { className: 'row-action', text: 'copy', attrs: { type: 'button' } });
      copy.addEventListener('click', () => navigator.clipboard.writeText(command)
        .then(() => notify('Command copied'))
        .catch(() => notify('Clipboard access failed.', true)));
      blocks.push(element('div', { className: 'git-clone' }, [
        element('p', {}, ['Get it back from ', link(remoteLabel(origin), origin.web), ':']),
        element('div', { className: 'git-form-row' }, [element('code', { text: command }), copy])
      ]));
    }
    el.body.replaceChildren(...blocks);
  }

  el.refresh.addEventListener('click', () => {
    if (session && !session.busy) load(session);
  });
  el.close.addEventListener('click', () => el.dialog.close());
  el.dialog.addEventListener('close', () => {
    session = null;
  });

  return { open };
}
