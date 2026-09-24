import { api } from './api.js';
import { $, badge, element, icon, setIcon } from './dom.js';
import { basename, formatBytes, formatDate, pathSegments, plural, shortAge, tildify } from './format.js';
import { fileManager } from './platform.js';

const MEASURE_CONCURRENCY = 3;
const rowTemplate = document.querySelector('#browser-row-template');

export function createBrowserPanel({ getExtraRoots, onReview, onVisibilityChange, notify }) {
  const el = {
    workspace: $('#workspace'),
    panel: $('#browser-panel'),
    crumbs: $('#browser-crumbs'),
    title: $('#browser-heading'),
    context: $('#browser-context'),
    list: $('#browser-list'),
    progress: $('#browser-progress'),
    selection: $('#browser-selection'),
    review: $('#browser-review'),
    selectAll: $('#browser-select-all'),
    hidden: $('#browser-hidden'),
    up: $('#browser-up'),
    refresh: $('#browser-refresh'),
    finder: $('#browser-finder'),
    close: $('#browser-close'),
    sortButtons: [...document.querySelectorAll('[data-browser-sort]')]
  };
  const state = {
    path: null,
    listing: null,
    sizes: new Map(),
    failed: new Set(),
    selected: new Set(),
    sort: 'size',
    showHidden: true,
    generation: 0,
    controllers: new Set(),
    pending: 0,
    loading: false,
    error: null,
    frame: 0
  };

  function abortMeasurements() {
    for (const controller of state.controllers) controller.abort();
    state.controllers.clear();
  }

  function scheduleRender() {
    if (state.frame) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = 0;
      render();
    });
  }

  function isOpen() {
    return !el.panel.hidden;
  }

  function show() {
    if (isOpen()) return;
    el.panel.hidden = false;
    el.workspace.classList.add('has-panel');
    onVisibilityChange?.(true);
  }

  function close() {
    state.generation += 1;
    abortMeasurements();
    el.panel.hidden = true;
    el.workspace.classList.remove('has-panel');
    onVisibilityChange?.(false);
  }

  async function open(path) {
    if (path !== state.path) state.selected.clear();
    state.path = path;
    show();
    await load();
    el.list.scrollTop = 0;
  }

  async function load({ fresh = false } = {}) {
    const generation = ++state.generation;
    abortMeasurements();
    state.loading = true;
    state.error = null;
    render();
    try {
      const listing = await api.browse(state.path, getExtraRoots());
      if (generation !== state.generation) return;
      state.listing = listing;
      state.sizes = new Map(listing.entries
        .filter((entry) => entry.sizeBytes != null && !(fresh && entry.type === 'dir'))
        .map((entry) => [entry.path, entry.sizeBytes]));
      state.failed = new Set();
      const present = new Set(listing.entries.map((entry) => entry.path));
      for (const path of state.selected) if (!present.has(path)) state.selected.delete(path);
      state.loading = false;
      render();
      await measureFolders(generation, fresh);
    } catch (error) {
      if (generation !== state.generation) return;
      state.loading = false;
      state.listing = null;
      state.error = error.message;
      render();
    }
  }

  // Deletable folders are measured first; protected ones still get a size so the
  // panel answers "what is taking space here", but after the actionable ones.
  async function measureFolders(generation, fresh) {
    const queue = state.listing.entries
      .filter((entry) => entry.type === 'dir' && !state.sizes.has(entry.path))
      .sort((a, b) => Number(Boolean(a.lock)) - Number(Boolean(b.lock)));
    state.pending = queue.length;
    scheduleRender();
    const worker = async () => {
      while (queue.length && generation === state.generation) {
        const entry = queue.shift();
        const controller = new AbortController();
        state.controllers.add(controller);
        try {
          const result = await api.measure(entry.path, { fresh, signal: controller.signal });
          if (generation === state.generation) state.sizes.set(entry.path, result.totalSizeBytes);
        } catch {
          if (generation === state.generation) state.failed.add(entry.path);
        } finally {
          state.controllers.delete(controller);
          if (generation === state.generation) {
            state.pending -= 1;
            scheduleRender();
          }
        }
      }
    };
    await Promise.all(Array.from({ length: MEASURE_CONCURRENCY }, worker));
  }

  function sizeOf(entry) {
    return entry.type === 'dir' ? state.sizes.get(entry.path) ?? null : entry.sizeBytes;
  }

  // While folders are still being measured the list stays in name order, so rows
  // do not jump under the pointer; it switches to size order once every size is in.
  function visibleEntries() {
    const entries = state.listing.entries.filter((entry) => state.showHidden || !entry.name.startsWith('.'));
    const byName = (a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    if (state.sort === 'name' || (state.sort === 'size' && state.pending > 0)) return entries.sort(byName);
    if (state.sort === 'modified') {
      return entries.sort((a, b) => new Date(b.modifiedAt || 0) - new Date(a.modifiedAt || 0) || byName(a, b));
    }
    return entries.sort((a, b) => (sizeOf(b) ?? -1) - (sizeOf(a) ?? -1) || byName(a, b));
  }

  function renderHeader() {
    const segments = pathSegments(state.path);
    el.crumbs.replaceChildren(...segments.flatMap((segment, index) => {
      const crumb = element('button', { text: segment.label, title: tildify(segment.path), attrs: { type: 'button' } });
      if (index === segments.length - 1) crumb.setAttribute('aria-current', 'page');
      crumb.addEventListener('click', () => open(segment.path));
      // The disk root is itself "/", so the first folder after it needs no separator.
      const separated = index > 1 || (index === 1 && segments[0].path !== '/');
      return separated ? [element('span', { className: 'sep', text: '/', attrs: { 'aria-hidden': 'true' } }), crumb] : [crumb];
    }));
    el.up.disabled = state.path === '/';

    const known = state.listing ? state.listing.entries.map(sizeOf).filter((size) => size != null) : [];
    const total = known.reduce((sum, size) => sum + size, 0);
    el.title.replaceChildren(
      element('span', { text: basename(state.path) }),
      state.listing ? element('small', { text: `${formatBytes(total)}${state.pending ? '+' : ''}` }) : ''
    );

    const facts = [];
    const listing = state.listing;
    if (listing) {
      facts.push(element('span', { text: plural(listing.total, 'item') }));
      if (listing.insideArtifact) {
        facts.push(element('span', { className: 'is-artifact', text: `inside ${listing.insideArtifact.label.toLowerCase()} · rebuildable` }));
      } else if (listing.project) {
        const where = listing.project.path === listing.real || listing.project.path === state.path ? '' : ` ${listing.project.name}`;
        facts.push(element('span', { text: `${listing.project.kind} project${where}` }));
      }
      if (listing.lock) {
        facts.push(element('span', { className: 'is-lock', title: listing.lock }, [icon('lock'), listing.lock]));
      }
      if (listing.truncated) facts.push(element('span', { text: `showing the first ${listing.entries.length}` }));
    }
    el.context.replaceChildren(...facts);
  }

  // At most one badge, and only for facts that change the decision: why an entry
  // is locked, what rebuildable output it is, or that it is only a link. Project
  // folders already show a project icon, with their type in the tooltip.
  function badgeFor(entry) {
    if (entry.lock) {
      const lock = badge('protected', '', 'lock');
      lock.title = entry.lock;
      return lock;
    }
    if (entry.artifact) return badge(entry.artifact.label.toLowerCase(), 'warn');
    if (entry.type === 'symlink') {
      const link = badge('link', '', 'link');
      link.title = entry.linkTarget ? `Points to ${entry.linkTarget}. Deleting removes only the link.` : 'Symbolic link';
      return link;
    }
    return null;
  }

  function describeEntry(entry) {
    const facts = [entry.project ? `${entry.project.kind} project` : null, entry.repository ? 'Git repository' : null].filter(Boolean);
    return facts.length ? `${entry.name} · ${facts.join(' · ')}` : entry.name;
  }

  function buildRow(entry, largest) {
    const row = rowTemplate.content.firstElementChild.cloneNode(true);
    const selected = state.selected.has(entry.path);
    row.dataset.type = entry.type;
    row.classList.toggle('is-artifact', Boolean(entry.artifact || state.listing.insideArtifact));
    row.classList.toggle('is-project', Boolean(entry.project));
    row.classList.toggle('is-hidden-file', entry.name.startsWith('.'));
    row.classList.toggle('is-selected', selected);

    const iconName = entry.type === 'dir'
      ? entry.artifact ? 'artifact' : entry.project ? 'project' : 'folder'
      : entry.type === 'symlink' ? 'link' : 'file';
    setIcon(row.querySelector('.node-icon'), iconName);

    const name = row.querySelector('.entry-name');
    name.textContent = entry.name;
    name.title = entry.type === 'dir' ? `Open ${describeEntry(entry)}` : tildify(entry.path);
    if (entry.type === 'dir') name.addEventListener('click', () => open(entry.path));
    else name.addEventListener('click', () => reveal(entry.path));
    const entryBadge = badgeFor(entry);
    if (entryBadge) row.querySelector('.badges').append(entryBadge);

    const size = sizeOf(entry);
    const value = row.querySelector('.browser-size .value');
    const failed = state.failed.has(entry.path);
    value.textContent = size != null ? formatBytes(size) : failed ? 'n/a' : 'measuring';
    value.classList.toggle('is-pending', size == null && !failed);
    if (failed) value.title = 'Could not measure (no permission, or it changed).';
    row.querySelector('.browser-size .bar i').style.setProperty('--share', size ? (size / largest).toFixed(3) : '0');

    const modified = row.querySelector('.browser-modified');
    const modifiedMs = entry.modifiedAt ? new Date(entry.modifiedAt).getTime() : 0;
    modified.textContent = shortAge(modifiedMs);
    modified.title = `Modified ${formatDate(modifiedMs)}`;

    const checkbox = row.querySelector('input');
    checkbox.checked = selected;
    checkbox.disabled = Boolean(entry.lock);
    checkbox.setAttribute('aria-label', entry.lock ? `${entry.name} is protected` : `Select ${entry.name}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selected.add(entry.path);
      else state.selected.delete(entry.path);
      render();
    });

    const revealButton = row.querySelector('.reveal');
    revealButton.title = `Show in ${fileManager()}`;
    revealButton.setAttribute('aria-label', `Show ${entry.name} in ${fileManager()}`);
    revealButton.addEventListener('click', () => reveal(entry.path));
    const deleteButton = row.querySelector('.delete');
    deleteButton.disabled = Boolean(entry.lock);
    deleteButton.title = entry.lock || `Review deleting ${entry.name}`;
    deleteButton.setAttribute('aria-label', entry.lock ? `${entry.name} is protected` : `Review deleting ${entry.name}`);
    deleteButton.addEventListener('click', () => onReview([entry.path], `Delete ${entry.name}`));
    return row;
  }

  function renderSelection(entries) {
    const selectable = entries.filter((entry) => !entry.lock);
    const chosen = state.listing ? state.listing.entries.filter((entry) => state.selected.has(entry.path)) : [];
    const bytes = chosen.reduce((sum, entry) => sum + (sizeOf(entry) || 0), 0);
    const unmeasured = chosen.some((entry) => sizeOf(entry) == null);
    el.selection.textContent = chosen.length
      ? `${plural(chosen.length, 'item')} selected · ${formatBytes(bytes)}${unmeasured ? '+' : ''}`
      : 'Select items to review them for deletion.';
    el.review.disabled = !chosen.length;
    const selectedVisible = selectable.filter((entry) => state.selected.has(entry.path)).length;
    el.selectAll.disabled = !selectable.length;
    el.selectAll.checked = selectable.length > 0 && selectedVisible === selectable.length;
    el.selectAll.indeterminate = selectedVisible > 0 && selectedVisible < selectable.length;
  }

  function render() {
    if (!state.path) return;
    renderHeader();
    el.sortButtons.forEach((sortButton) => sortButton.setAttribute('aria-pressed', String(sortButton.dataset.browserSort === state.sort)));
    el.progress.textContent = state.loading
      ? 'reading…'
      : state.pending ? `measuring ${plural(state.pending, 'folder')}…` : '';
    if (state.error) {
      el.list.replaceChildren(element('p', { className: 'browser-error', text: state.error }));
      renderSelection([]);
      return;
    }
    if (!state.listing) {
      el.list.replaceChildren(element('p', { className: 'browser-empty', text: 'Reading folder…' }));
      renderSelection([]);
      return;
    }
    const entries = visibleEntries();
    if (!entries.length) {
      el.list.replaceChildren(element('p', {
        className: 'browser-empty',
        text: state.listing.total ? 'Only dotfiles here. Turn on dotfiles to see them.' : 'This folder is empty.'
      }));
      renderSelection([]);
      return;
    }
    const largest = Math.max(1, ...entries.map(sizeOf).filter((size) => size != null));
    const fragment = document.createDocumentFragment();
    for (const entry of entries) fragment.append(buildRow(entry, largest));
    el.list.replaceChildren(fragment);
    renderSelection(entries);
  }

  async function reveal(path) {
    try {
      await api.open(path, true);
    } catch (error) {
      notify(error.message, true);
    }
  }

  el.close.addEventListener('click', close);
  el.up.addEventListener('click', () => {
    const parent = state.listing?.parent ?? (state.path === '/' ? null : state.path.split('/').slice(0, -1).join('/') || '/');
    if (parent) open(parent);
  });
  el.refresh.addEventListener('click', () => load({ fresh: true }));
  el.finder.addEventListener('click', async () => {
    try {
      await api.open(state.path);
    } catch (error) {
      notify(error.message, true);
    }
  });
  el.hidden.addEventListener('change', () => {
    state.showHidden = el.hidden.checked;
    render();
  });
  el.sortButtons.forEach((sortButton) => sortButton.addEventListener('click', () => {
    state.sort = sortButton.dataset.browserSort;
    render();
  }));
  el.selectAll.addEventListener('change', () => {
    for (const entry of visibleEntries()) {
      if (entry.lock) continue;
      if (el.selectAll.checked) state.selected.add(entry.path);
      else state.selected.delete(entry.path);
    }
    render();
  });
  el.review.addEventListener('click', () => {
    const paths = [...state.selected];
    if (paths.length) onReview(paths, `Delete ${plural(paths.length, 'item')} from ${basename(state.path)}`);
  });
  el.panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.stopPropagation();
      close();
    }
  });

  return {
    open,
    close,
    isOpen,
    reload: () => (isOpen() && state.path ? load() : undefined),
    clearSelection: () => {
      state.selected.clear();
      render();
    }
  };
}
