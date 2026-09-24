import { api } from './api.js';
import { $, element, icon } from './dom.js';
import { formatBytes, formatCount, plural, tildify } from './format.js';

const NOTE_ICONS = { danger: 'alert', warn: 'alert', ok: 'check', info: 'info' };
const GIT_STATES = {
  ignored: 'Git: ignored',
  tracked: 'Git: tracked',
  untracked: 'Git: untracked',
  unknown: 'Git: unknown',
  none: 'not in a Git repo'
};
const CONFIRM_WORD = 'delete';

export function createCleanupDialog({ getExtraRoots, onStoreChange, onFinished, notify }) {
  const el = {
    dialog: $('#cleanup-dialog'),
    form: $('#cleanup-form'),
    title: $('#cleanup-title'),
    summary: $('#cleanup-summary'),
    body: $('#cleanup-body'),
    modes: $('#cleanup-modes'),
    confirmRow: $('#cleanup-confirm-row'),
    confirmInput: $('#cleanup-confirm-input'),
    progress: $('#cleanup-progress'),
    progressFill: $('#cleanup-progress-fill'),
    progressText: $('#cleanup-progress-text'),
    cancel: $('#cleanup-cancel'),
    stop: $('#cleanup-stop'),
    confirm: $('#cleanup-confirm'),
    close: $('#cleanup-close')
  };
  let session = null;

  const readyItems = () => session.plan.items.filter((item) => item.ok);
  const checkedItems = () => readyItems().filter((item) => session.checked.has(item.path));

  // Deleting something that cannot be rebuilt, permanently, asks for the word
  // "delete". Rebuildable output and anything headed to the Trash take one click.
  function needsTypedConfirm() {
    return session.mode === 'permanent' && checkedItems().some((item) => !item.rebuildable || item.risk === 'high');
  }

  async function review(paths, { title = 'Review deletion' } = {}) {
    if (session?.running) {
      notify('A deletion is still running.', true);
      return;
    }
    const current = { plan: null, checked: new Set(), mode: null, running: false, stopRequested: false, finished: false, latestStore: null, statuses: new Map() };
    session = current;
    el.title.textContent = title;
    el.summary.textContent = `Inspecting ${plural(paths.length, 'item')}: measuring, checking Git, looking for anything that cannot be rebuilt…`;
    el.body.replaceChildren(element('div', { className: 'dialog-loading' }, [icon('refresh'), element('p', { text: 'Preparing the review. Nothing is deleted yet.' })]));
    setFooter('loading');
    if (!el.dialog.open) el.dialog.showModal();
    try {
      const plan = await api.preview(paths, getExtraRoots());
      if (session !== current) return;
      current.plan = plan;
      for (const item of plan.items) if (item.ok && item.preselected) current.checked.add(item.path);
      current.mode = plan.defaultMode === 'trash' && !plan.trashAvailable ? null : plan.defaultMode;
      renderReview();
    } catch (error) {
      if (session !== current) return;
      el.summary.textContent = 'The review could not be prepared.';
      el.body.replaceChildren(element('p', { className: 'browser-error', text: error.message }));
      setFooter('error');
    }
  }

  function setFooter(phase) {
    const reviewing = phase === 'review';
    el.modes.hidden = !reviewing;
    el.progress.hidden = phase !== 'running' && phase !== 'finished';
    el.confirmRow.hidden = !(reviewing && needsTypedConfirm());
    el.cancel.hidden = phase === 'running';
    el.cancel.textContent = phase === 'finished' ? 'Done' : 'Cancel';
    el.stop.hidden = phase !== 'running';
    el.confirm.hidden = phase !== 'review' && phase !== 'loading';
    el.close.disabled = phase === 'running';
    if (phase === 'loading') el.confirm.disabled = true;
  }

  function renderSummary() {
    const ready = readyItems();
    const chosen = checkedItems();
    const blocked = session.plan.items.length - ready.length;
    const bytes = chosen.reduce((sum, item) => sum + item.sizeBytes, 0);
    el.summary.replaceChildren(
      `${chosen.length} of ${plural(ready.length, 'item')} selected · `,
      element('strong', { text: formatBytes(bytes) }),
      blocked ? ` · ${blocked} protected or missing` : ''
    );
    return bytes;
  }

  function renderControls() {
    const bytes = renderSummary();
    const chosen = checkedItems();
    const trashOption = el.modes.querySelector('input[value="trash"]');
    trashOption.disabled = !session.plan.trashAvailable;
    for (const input of el.modes.querySelectorAll('input')) input.checked = input.value === session.mode;
    const typed = needsTypedConfirm();
    el.confirmRow.hidden = !typed;
    if (!typed) el.confirmInput.value = '';
    el.confirm.textContent = session.mode === 'trash'
      ? `Move ${formatBytes(bytes)} to Trash`
      : session.mode === 'permanent' ? `Delete ${formatBytes(bytes)} permanently` : 'Choose how to delete';
    el.confirm.disabled = !chosen.length || !session.mode ||
      (typed && el.confirmInput.value.trim().toLowerCase() !== CONFIRM_WORD);
  }

  function factList(item) {
    const facts = [];
    if (item.type === 'dir') facts.push(element('span', { text: `${plural(item.fileCount, 'file')} in ${plural(item.dirCount, 'folder')}` }));
    if (item.project && item.role !== 'project') facts.push(element('span', { text: `in ${item.project.name}` }));
    facts.push(element('span', { text: GIT_STATES[item.git?.state] || 'Git: unknown' }));
    if (item.restore?.command) facts.push(element('span', {}, ['restore ', element('code', { text: item.restore.command })]));
    return facts;
  }

  function reviewItem(item) {
    const status = session.statuses.get(item.path);
    const checked = session.checked.has(item.path);
    const article = element('article', { className: `review-item${checked ? '' : ' is-unchecked'}` });
    const checkbox = element('input', { attrs: { type: 'checkbox', 'aria-label': `Include ${item.name}` } });
    checkbox.checked = checked;
    checkbox.disabled = session.running || session.finished;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) session.checked.add(item.path);
      else session.checked.delete(item.path);
      article.classList.toggle('is-unchecked', !checkbox.checked);
      renderControls();
    });

    const main = element('div', { className: 'review-main' }, [
      element('div', { className: 'review-head' }, [
        element('span', { className: 'review-name', text: item.name }),
        element('span', { className: 'review-label', text: item.label }),
        element('span', { className: `risk risk-${item.risk}`, text: `${item.risk} risk` }),
        element('span', { className: 'review-size', text: formatBytes(item.sizeBytes) })
      ]),
      element('div', { className: 'review-path', text: tildify(item.real || item.path), title: item.real || item.path }),
      element('div', { className: 'review-facts' }, factList(item))
    ]);
    if (item.notes?.length) {
      main.append(element('ul', { className: 'review-notes' }, item.notes.map((note) =>
        element('li', { className: `note-${note.level}` }, [icon(NOTE_ICONS[note.level] || 'alert'), element('span', { text: note.text })])
      )));
    }
    if (item.sample?.entries?.length) {
      const names = item.sample.entries.map((entry) => `${entry.name}${entry.type === 'dir' ? '/' : ''}`).join('  ');
      const more = item.sample.total > item.sample.entries.length ? `  … and ${formatCount(item.sample.total - item.sample.entries.length)} more` : '';
      main.append(element('details', { className: 'review-contents' }, [
        element('summary', { text: `what's inside · ${plural(item.sample.total, 'entry', 'entries')}` }),
        element('p', { text: `${names}${more}` })
      ]));
    }
    if (status) {
      const statusIcon = status.state === 'done' ? 'check' : status.state === 'failed' ? 'alert' : 'refresh';
      main.append(element('div', { className: `review-status is-${status.state}` }, [icon(statusIcon), element('span', { text: status.text })]));
    }
    article.append(element('label', { className: 'check' }, [checkbox, element('span')]), main);
    return article;
  }

  function blockedItem(item) {
    return element('article', { className: 'review-item is-blocked' }, [
      element('span', { className: 'check' }, [icon('lock')]),
      element('div', { className: 'review-main' }, [
        element('div', { className: 'review-head' }, [element('span', { className: 'review-name', text: item.name })]),
        element('div', { className: 'review-path', text: tildify(item.path), title: item.path }),
        element('div', { className: 'blocked-reason', text: item.reason })
      ])
    ]);
  }

  function renderItems() {
    const ready = readyItems();
    const blocked = session.plan.items.filter((item) => !item.ok);
    const sections = [];
    if (ready.length) sections.push(...ready.map(reviewItem));
    else sections.push(element('p', { className: 'browser-empty', text: 'Nothing here can be deleted.' }));
    if (blocked.length) {
      sections.push(element('h3', { className: 'review-section-title', text: 'Protected or no longer there' }), ...blocked.map(blockedItem));
    }
    el.body.replaceChildren(...sections);
  }

  function renderReview() {
    renderItems();
    setFooter('review');
    renderControls();
  }

  function updateProgress(done, total, freed) {
    el.progressFill.style.setProperty('--progress', String(total ? done / total : 0));
    el.progressText.textContent = `${done} of ${total} done · ${formatBytes(freed)} ${session.mode === 'trash' ? 'moved to Trash' : 'freed'}`;
  }

  async function execute() {
    const items = checkedItems();
    if (!items.length || !session.mode) return;
    const current = session;
    current.running = true;
    setFooter('running');
    renderItems();
    let finished = 0;
    let freed = 0;
    let failures = 0;
    updateProgress(0, items.length, 0);

    for (const item of items) {
      if (current.stopRequested) break;
      current.statuses.set(item.path, { state: 'running', text: current.mode === 'trash' ? 'Moving to Trash…' : 'Deleting…' });
      renderItems();
      try {
        const result = await api.execute(current.plan.planId, item.path, current.mode);
        freed += result.freedBytes;
        current.latestStore = result.store || current.latestStore;
        if (result.ok) {
          current.statuses.set(item.path, {
            state: 'done',
            text: `${current.mode === 'trash' ? 'Moved to Trash' : 'Deleted'} · ${formatBytes(result.freedBytes)} in ${(result.durationMs / 1000).toFixed(1)}s`
          });
        } else {
          failures += 1;
          current.statuses.set(item.path, { state: 'failed', text: `${result.error} ${formatBytes(result.freedBytes)} was freed.` });
        }
      } catch (error) {
        failures += 1;
        current.statuses.set(item.path, { state: 'failed', text: error.message });
      }
      finished += 1;
      updateProgress(finished, items.length, freed);
      renderItems();
    }

    current.running = false;
    current.finished = true;
    const skipped = items.length - finished;
    el.title.textContent = failures ? 'Finished with problems' : 'Done';
    el.summary.replaceChildren(
      current.mode === 'trash' ? 'Moved ' : 'Freed ',
      element('strong', { text: formatBytes(freed) }),
      current.mode === 'trash' ? ' to the Trash. Empty the Trash to free the space.' : '.',
      failures ? ` ${plural(failures, 'item')} failed.` : '',
      skipped ? ` ${skipped} skipped after you stopped.` : ''
    );
    setFooter('finished');
    renderItems();
    if (current.latestStore) onStoreChange(current.latestStore);
  }

  el.modes.addEventListener('change', (event) => {
    if (event.target.name !== 'mode' || !session?.plan) return;
    session.mode = event.target.value;
    renderControls();
  });
  el.confirmInput.addEventListener('input', () => {
    if (session?.plan) renderControls();
  });
  el.confirm.addEventListener('click', () => {
    if (!el.confirm.disabled) execute();
  });
  el.stop.addEventListener('click', () => {
    session.stopRequested = true;
    el.stop.disabled = true;
    el.stop.textContent = 'Stopping after this item…';
  });
  const requestClose = () => {
    if (session?.running) return;
    el.dialog.close();
  };
  el.cancel.addEventListener('click', requestClose);
  el.close.addEventListener('click', requestClose);
  // Enter in the confirm field must not submit (and close) the dialog.
  el.form.addEventListener('submit', (event) => event.preventDefault());
  el.dialog.addEventListener('cancel', (event) => {
    if (session?.running) event.preventDefault();
  });
  el.dialog.addEventListener('close', () => {
    const closed = session;
    session = null;
    el.stop.disabled = false;
    el.stop.textContent = 'Stop after this item';
    el.confirmInput.value = '';
    if (closed?.finished) onFinished?.();
  });

  return { review };
}
