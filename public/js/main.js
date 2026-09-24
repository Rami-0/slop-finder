import { api } from './api.js';
import { isInactive } from './activity.js';
import { createBrowserPanel } from './browser-panel.js';
import { createCleanupDialog } from './cleanup-dialog.js';
import { $, element } from './dom.js';
import { formatBytes, isInside, plural, relativeTime, setHome } from './format.js';
import { createGitDialog } from './git-dialog.js';
import { createGitLoader } from './git-view.js';
import { getExtraRoots, initLocations } from './locations.js';
import { fileManager, setPlatform } from './platform.js';
import { artifactPaths, enableKeyboard, projectState, renderRows } from './projects-view.js';
import { allNodes, buildTree, displayName, flattenTree, projectActiveMs, projectSize, sortTree } from './tree.js';

const CLEANABLE_MIN_BYTES = 50_000_000;
const PREFS_KEY = 'slop-finder.prefs';
const SCOPES = {
  code: (project) => project.category === 'code',
  infra: (project) => project.category === 'infrastructure',
  repo: (project) => ['repository', 'documentation', 'config'].includes(project.category),
  content: (project) => ['data', 'documentation'].includes(project.category),
  all: () => true
};
const HEADER_SORTS = {
  name: ['name', 'name-desc'],
  type: ['type', 'type-desc'],
  size: ['size-desc', 'size-asc'],
  cleanup: ['cleanup', 'cleanup-asc'],
  active: ['active-desc', 'active-asc']
};

const el = {
  form: $('#scan-form'), root: $('#scan-root'), scanButton: $('#scan-button'), scanStatus: $('#scan-status'),
  stickyTop: $('#sticky-top'), rows: $('#project-rows'), empty: $('#empty-state'), emptyTitle: $('#empty-title'),
  emptyHint: $('#empty-hint'), rescanNotice: $('#rescan-notice'), search: $('#project-search'), sort: $('#project-sort'),
  selectAll: $('#select-all'), bulkBar: $('#bulk-bar'), selectedCount: $('#selected-count'), selectedSize: $('#selected-size'),
  toast: $('#toast'), visibleCount: $('#visible-count'), projectCount: $('#project-count'), missingCount: $('#missing-count'),
  reclaimableSize: $('#reclaimable-size'), totalSize: $('#total-size'), lastScan: $('#last-scan'),
  reclaimedTotal: $('#reclaimed-total'), reclaimedScan: $('#reclaimed-scan'), reclaimNote: $('#reclaim-note'),
  reclaimFill: $('#reclaim-fill'), historyToggle: $('#history-toggle'), reclaimHistory: $('#reclaim-history'),
  historyList: $('#history-list'), treeTools: $('.tree-tools'), cleanableToggle: $('#cleanable-toggle'),
  inactiveToggle: $('#inactive-toggle'), ghChip: $('#gh-chip'), systemLabel: $('#system-label'),
  platformNotice: $('#platform-notice'), platformNoticeText: $('#platform-notice-text'), browserFinder: $('#browser-finder')
};

const state = {
  store: null,
  projects: [],
  view: 'tree',
  scope: 'code',
  status: 'present',
  cleanableOnly: false,
  inactiveOnly: false,
  query: '',
  sort: 'size-desc',
  selected: new Set(),
  expanded: new Map(),
  scanning: false,
  focusKey: null,
  restoreFocus: false
};
let nodesByKey = new Map();
let visibleMatched = [];
let toastTimer;
let renderFrame = 0;

// View preferences are a per-browser convenience; everything works without them.
function loadPrefs() {
  try {
    const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    for (const key of ['view', 'scope', 'status', 'sort']) if (typeof prefs[key] === 'string') state[key] = prefs[key];
    state.cleanableOnly = Boolean(prefs.cleanableOnly);
    state.inactiveOnly = Boolean(prefs.inactiveOnly);
    if (Array.isArray(prefs.expanded)) state.expanded = new Map(prefs.expanded.slice(-3000));
  } catch {}
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      view: state.view,
      scope: state.scope,
      status: state.status,
      sort: state.sort,
      cleanableOnly: state.cleanableOnly,
      inactiveOnly: state.inactiveOnly,
      expanded: [...state.expanded].slice(-3000)
    }));
  } catch {}
}

function notify(message, isError = false) {
  clearTimeout(toastTimer);
  el.toast.textContent = message;
  el.toast.classList.toggle('error', isError);
  el.toast.classList.add('is-visible');
  toastTimer = setTimeout(() => el.toast.classList.remove('is-visible'), isError ? 4200 : 2400);
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    notify(message);
  } catch {
    notify('Clipboard access failed.', true);
  }
}

// Filtering

function inStatus(project) {
  if (state.status === 'ignored') return Boolean(project.ignored);
  if (project.ignored) return false;
  return state.status === 'missing' ? project.status === 'missing' : project.status !== 'missing';
}

function matches(project) {
  if (!inStatus(project) || !(SCOPES[state.scope] || SCOPES.all)(project)) return false;
  if (state.query) {
    const haystack = `${project.name} ${project.path} ${project.kind} ${project.category}`.toLowerCase();
    if (!haystack.includes(state.query)) return false;
  }
  if (state.cleanableOnly && (project.reclaimableSizeBytes || 0) < CLEANABLE_MIN_BYTES) return false;
  if (state.inactiveOnly && !isInactive(projectActiveMs(project))) return false;
  return true;
}

function compareNodes(sortKey) {
  const text = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
  const byName = (a, b) => text(displayName(a), displayName(b));
  const kind = (node) => node.project?.kind || '';
  const stateOf = (node) => (node.project ? projectState(node.project) : '');
  const idleOrder = (node) => node.totals.lastActiveMs || Number.MAX_SAFE_INTEGER;
  const comparators = {
    'size-desc': (a, b) => b.totals.diskBytes - a.totals.diskBytes || byName(a, b),
    'size-asc': (a, b) => a.totals.diskBytes - b.totals.diskBytes || byName(a, b),
    cleanup: (a, b) => b.totals.rebuildableBytes - a.totals.rebuildableBytes || byName(a, b),
    'cleanup-asc': (a, b) => a.totals.rebuildableBytes - b.totals.rebuildableBytes || byName(a, b),
    'active-desc': (a, b) => b.totals.lastActiveMs - a.totals.lastActiveMs || byName(a, b),
    'active-asc': (a, b) => idleOrder(a) - idleOrder(b) || byName(a, b),
    name: byName,
    'name-desc': (a, b) => byName(b, a),
    type: (a, b) => text(kind(a), kind(b)) || byName(a, b),
    'type-desc': (a, b) => text(kind(b), kind(a)) || byName(a, b),
    state: (a, b) => text(stateOf(a), stateOf(b)) || byName(a, b),
    'state-desc': (a, b) => text(stateOf(b), stateOf(a)) || byName(a, b)
  };
  return comparators[sortKey] || comparators['size-desc'];
}

function listNode(project) {
  const missing = project.status === 'missing';
  return {
    key: project.path,
    path: project.path,
    kind: 'project',
    project,
    context: false,
    children: [],
    totals: {
      diskBytes: missing ? 0 : projectSize(project),
      rebuildableBytes: missing ? 0 : project.reclaimableSizeBytes || 0,
      lastActiveMs: projectActiveMs(project)
    }
  };
}

function isExpanded(node) {
  return state.expanded.has(node.key) ? state.expanded.get(node.key) : node.kind === 'folder';
}

function toggleExpanded(node) {
  state.expanded.set(node.key, !isExpanded(node));
  savePrefs();
  render();
}

// Matching projects plus the non-matching projects that contain them, so a
// nested match is shown inside its real parent instead of floating loose.
function treeRows(matched) {
  const byPath = new Map(state.projects.map((project) => [project.path, project]));
  const matchedPaths = new Set(matched.map((project) => project.path));
  const context = new Map();
  for (const project of matched) {
    let parent = byPath.get(project.parentProjectPath);
    while (parent && !matchedPaths.has(parent.path) && !context.has(parent.path) && inStatus(parent)) {
      context.set(parent.path, parent);
      parent = byPath.get(parent.parentProjectPath);
    }
  }
  const root = buildTree(matched, [...context.values()]);
  sortTree(root, compareNodes(state.sort));
  nodesByKey = new Map(allNodes(root).map((node) => [node.key, node]));
  return flattenTree(root, { isExpanded, forceOpen: Boolean(state.query) });
}

function listRows(matched) {
  const nodes = matched.filter((project) => !project.contained).map(listNode).sort(compareNodes(state.sort));
  const largest = Math.max(1, ...nodes.map((node) => node.totals.rebuildableBytes));
  nodesByKey = new Map(nodes.map((node) => [node.key, node]));
  return nodes.map((node) => ({ kind: 'project', node, depth: 0, expandable: false, expanded: false, share: node.totals.rebuildableBytes / largest }));
}

// Rendering

function renderOverview() {
  const active = state.projects.filter((project) => !project.ignored);
  const present = active.filter((project) => project.status !== 'missing');
  const topLevel = present.filter((project) => !project.contained);
  const potential = topLevel.reduce((sum, project) => sum + (project.reclaimableSizeBytes || 0), 0);
  el.visibleCount.textContent = visibleMatched.length;
  el.projectCount.textContent = state.projects.length;
  el.missingCount.textContent = active.length - present.length;
  el.totalSize.textContent = formatBytes(topLevel.reduce((sum, project) => sum + projectSize(project), 0));
  el.reclaimableSize.textContent = formatBytes(potential);
  el.rescanNotice.hidden = !present.some((project) => !Array.isArray(project.artifacts));

  const store = state.store || {};
  const reclaimed = store.reclaimedTotalBytes || 0;
  const denominator = reclaimed + potential;
  el.reclaimedTotal.textContent = formatBytes(reclaimed);
  el.reclaimedScan.textContent = `+${formatBytes(store.lastScanReclaimedBytes || 0)} this scan`;
  el.reclaimFill.style.setProperty('--progress', String(denominator ? Math.min(1, reclaimed / denominator) : 0));
  renderHistory(store.reclaimHistory || []);
}

const REASONS = {
  'project-removed': () => 'folder removed',
  'size-reduced': () => 'size reduced',
  deleted: (event) => `${(event.label || 'item').toLowerCase()} deleted`,
  trashed: (event) => `${(event.label || 'item').toLowerCase()} moved to Trash`
};

function renderHistory(history) {
  el.reclaimNote.textContent = history.length ? `${plural(history.length, 'reclaim event')} recorded locally` : 'recent reclaim events';
  if (!history.length) {
    el.historyList.replaceChildren(element('p', {
      className: 'history-empty',
      text: 'Nothing reclaimed yet. Cleanups you run here, and space freed between scans, show up in this list.'
    }));
    return;
  }
  el.historyList.replaceChildren(...history.slice(0, 12).map((event) => {
    const target = event.targetPath && event.targetPath !== event.projectPath && isInside(event.targetPath, event.projectPath)
      ? `${event.targetPath.slice(event.projectPath.length + 1)} · `
      : '';
    const reason = (REASONS[event.reason] || (() => event.reason))(event);
    return element('div', { className: 'history-row' }, [
      element('div', { className: 'history-project', text: event.projectName }, [
        element('small', { text: `${target}${reason} · ${relativeTime(event.at)}` })
      ]),
      element('span', { className: 'history-amount', text: `+${formatBytes(event.bytes)}` })
    ]);
  }));
}

function selectedProjects() {
  return state.projects.filter((project) => state.selected.has(project.path));
}

function renderSelection() {
  const chosen = selectedProjects();
  const sizes = new Map();
  for (const project of chosen) {
    if (project.status === 'missing') continue;
    for (const artifact of project.artifacts || []) sizes.set(artifact.path, artifact.sizeBytes);
  }
  const rebuildable = [...sizes.values()].reduce((sum, size) => sum + size, 0);
  el.selectedCount.textContent = chosen.length;
  el.selectedSize.textContent = chosen.length ? `· ${formatBytes(rebuildable)} rebuildable` : '';
  el.bulkBar.hidden = chosen.length === 0;
  $('#clean-selected').disabled = !sizes.size || state.scanning;

  const selectable = visibleMatched.map((project) => project.path);
  const selectedVisible = selectable.filter((path) => state.selected.has(path)).length;
  el.selectAll.checked = selectable.length > 0 && selectedVisible === selectable.length;
  el.selectAll.indeterminate = selectedVisible > 0 && selectedVisible < selectable.length;
}

function renderControls() {
  document.querySelectorAll('[data-view]').forEach((control) => control.setAttribute('aria-pressed', String(control.dataset.view === state.view)));
  document.querySelectorAll('[data-filter-group]').forEach((group) => {
    const current = state[group.dataset.filterGroup];
    group.querySelectorAll('button').forEach((control) => control.setAttribute('aria-pressed', String(control.dataset.value === current)));
  });
  el.cleanableToggle.checked = state.cleanableOnly;
  el.inactiveToggle.checked = state.inactiveOnly;
  el.treeTools.hidden = state.view !== 'tree';
  if ([...el.sort.options].some((option) => option.value === state.sort)) el.sort.value = state.sort;
  document.querySelectorAll('.sortable-column').forEach((column) => {
    const [first, second] = HEADER_SORTS[column.dataset.sortKey];
    const direction = state.sort === first
      ? (first.endsWith('desc') || first === 'cleanup' ? 'descending' : 'ascending')
      : state.sort === second ? (second.endsWith('desc') ? 'descending' : 'ascending') : 'none';
    column.setAttribute('aria-sort', direction);
    column.querySelector('i').textContent = direction === 'ascending' ? '↑' : direction === 'descending' ? '↓' : '';
  });
}

function renderEmpty(rows) {
  el.empty.hidden = rows.length > 0;
  if (rows.length) return;
  if (!state.projects.length) {
    el.emptyTitle.textContent = 'No projects indexed yet.';
    el.emptyHint.textContent = 'Choose a folder above and scan it.';
  } else if (state.inactiveOnly && !visibleMatched.length) {
    el.emptyTitle.textContent = 'No inactive projects match.';
    el.emptyHint.textContent = 'The inactive filter uses activityLevel() in public/js/activity.js to decide what counts as inactive.';
  } else {
    el.emptyTitle.textContent = 'No matching projects.';
    el.emptyHint.textContent = 'Try another type or status, or clear the search.';
  }
}

function render() {
  visibleMatched = state.projects.filter(matches);
  const rows = state.view === 'tree' ? treeRows(visibleMatched) : listRows(visibleMatched);
  renderRows(el.rows, rows, {
    mode: state.view,
    selected: state.selected,
    busy: state.scanning,
    focusKey: state.focusKey,
    restoreFocus: state.restoreFocus,
    onToggle: toggleExpanded,
    onSelect: (paths, checked) => {
      for (const path of paths) {
        if (checked) state.selected.add(path);
        else state.selected.delete(path);
      }
      render();
    },
    onBrowse: (path) => browser.open(path),
    onClean: reviewCleanup,
    onOpen: openProject,
    onCopy: (path) => copyText(path, 'Path copied'),
    gitFor: (project) => gitState.get(project),
    onGit: (project) => gitDialog.open(project)
  });
  state.restoreFocus = false;
  renderOverview();
  renderControls();
  renderSelection();
  renderEmpty(rows);
}

// Git answers arrive in batches; one render per frame is enough for all of them.
function scheduleRender() {
  if (renderFrame) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = 0;
    render();
  });
}

function applyStore(store) {
  state.store = store;
  state.projects = store.projects || [];
  setHome(store.home);
  const known = new Set(state.projects.map((project) => project.path));
  for (const path of [...state.selected]) if (!known.has(path)) state.selected.delete(path);
  el.root.value = store.scanRoot || '';
  el.lastScan.textContent = store.lastScanAt
    ? `scanned ${relativeTime(store.lastScanAt)} · ${(store.inspectedDirectories || 0).toLocaleString('en-US')} folders · ${((store.scanDurationMs || 0) / 1000).toFixed(1)}s`
    : 'never scanned';
  render();
  gitState.refresh(state.projects);
}

// Actions

function reviewCleanup(paths, title) {
  if (state.scanning) {
    notify('Wait for the scan to finish first.', true);
    return;
  }
  if (!paths.length) {
    notify('Nothing rebuildable found here. Scan again if you expected something.', true);
    return;
  }
  cleanup.review(paths, { title });
}

async function openProject(project) {
  try {
    await api.open(project.path);
    notify(`Opened ${project.name}`);
  } catch (error) {
    notify(error.message, true);
  }
}

async function loadProjects() {
  try {
    applyStore(await api.projects());
  } catch (error) {
    notify(error.message, true);
  }
}

// Which machine this is. Labels such as "Open in Finder" follow it, and a system
// other than macOS gets a plain notice that it is untested there.
async function loadSystem() {
  try {
    const info = await api.system();
    setPlatform(info);
    el.systemLabel.textContent = `localhost · ${info.name}${info.version ? ` ${info.version}` : ''}`;
    el.systemLabel.title = [info.name, info.version, info.build && `(${info.build})`, info.arch].filter(Boolean).join(' ');
    el.browserFinder.title = `Open in ${fileManager()}`;
    el.browserFinder.querySelector('.sr-only').textContent = `Open in ${fileManager()}`;
    el.platformNotice.hidden = info.supported;
    el.platformNoticeText.textContent = info.supported ? '' : `Slop Finder is built and tested on macOS. This is ${info.name}: it runs, but some protections and labels are tuned for macOS.`;
    render();
  } catch {}
}

// The header chip says whether the GitHub CLI session is usable. Without it the
// Git dialog hides commit, push, and create, and says why.
function renderGithub(status) {
  el.ghChip.classList.toggle('is-ready', Boolean(status?.ready));
  el.ghChip.classList.toggle('is-problem', Boolean(status) && !status.ready);
  el.ghChip.textContent = !status ? 'gh …' : status.ready ? `gh · ${status.login}` : status.installed ? 'gh: sign in' : 'gh: not installed';
  el.ghChip.title = !status
    ? 'Checking the GitHub CLI session…'
    : status.ready
      ? `GitHub CLI signed in as ${status.login} on ${status.host}. Commit and push from a project's git chip. Click to check again.`
      : `${status.reason} Commit and push stay hidden until then. Click to check again.`;
}

async function checkGithub({ fresh = false, announce = false } = {}) {
  try {
    const status = await api.githubStatus(fresh);
    renderGithub(status);
    if (announce) notify(status.ready ? `gh is signed in as ${status.login}` : status.reason, !status.ready);
  } catch (error) {
    if (announce) notify(error.message, true);
  }
}

async function runScan(event) {
  event.preventDefault();
  state.scanning = true;
  el.scanButton.disabled = true;
  el.scanButton.classList.add('is-scanning');
  el.scanStatus.classList.remove('error');
  el.scanStatus.textContent = 'scanning…';
  render();
  try {
    const store = await api.scan(el.root.value.trim());
    state.selected.clear();
    state.scanning = false;
    applyStore(store);
    el.scanStatus.textContent = `${store.projects.filter((project) => project.status === 'present').length} found`;
    notify(store.lastScanReclaimedBytes ? `${formatBytes(store.lastScanReclaimedBytes)} reclaimed since the last scan` : 'Index updated');
    browser.reload();
  } catch (error) {
    el.scanStatus.textContent = 'scan failed';
    el.scanStatus.classList.add('error');
    notify(error.message, true);
  } finally {
    state.scanning = false;
    el.scanButton.disabled = false;
    el.scanButton.classList.remove('is-scanning');
    render();
  }
}

async function setIgnored(ignored) {
  if (!state.selected.size) return;
  try {
    const count = state.selected.size;
    const store = await api.ignore([...state.selected], ignored);
    state.selected.clear();
    applyStore(store);
    notify(`${plural(count, 'project')} ${ignored ? 'ignored' : 'restored'}`);
  } catch (error) {
    notify(error.message, true);
  }
}

function setAllExpanded(expanded) {
  for (const node of nodesByKey.values()) {
    if (node.children.length || node.project?.artifacts?.length) state.expanded.set(node.key, expanded);
  }
  savePrefs();
  render();
}

// Wiring

const browser = createBrowserPanel({
  getExtraRoots,
  notify,
  onReview: reviewCleanup,
  onVisibilityChange: () => requestAnimationFrame(() => render())
});

const cleanup = createCleanupDialog({
  getExtraRoots,
  notify,
  onStoreChange: applyStore,
  onFinished: () => browser.reload()
});

initLocations({ notify, onChange: () => browser.reload() });

const gitState = createGitLoader({
  onUpdate: scheduleRender,
  onError: (error) => notify(`Could not read Git state: ${error.message}`, true)
});

const gitDialog = createGitDialog({
  notify,
  onChange: (path, git) => gitState.set(path, git),
  onGithubStatus: renderGithub
});

el.ghChip.addEventListener('click', async () => {
  el.ghChip.disabled = true;
  await checkGithub({ fresh: true, announce: true });
  el.ghChip.disabled = false;
});

enableKeyboard(el.rows, {
  onToggleKey: (key) => {
    const node = nodesByKey.get(key);
    if (!node) return;
    state.focusKey = key;
    state.restoreFocus = true;
    toggleExpanded(node);
  },
  rememberFocus: (key) => {
    state.focusKey = key;
    state.restoreFocus = true;
  }
});

new ResizeObserver(([entry]) => {
  document.documentElement.style.setProperty('--sticky-height', `${Math.ceil(entry.borderBoxSize?.[0]?.blockSize ?? entry.target.offsetHeight)}px`);
}).observe(el.stickyTop);

el.form.addEventListener('submit', runScan);
el.search.addEventListener('input', (event) => {
  state.query = event.target.value.trim().toLowerCase();
  render();
});
el.sort.addEventListener('change', (event) => {
  state.sort = event.target.value;
  savePrefs();
  render();
});
document.querySelectorAll('.sortable-column button').forEach((control) => {
  control.addEventListener('click', () => {
    const [first, second] = HEADER_SORTS[control.parentElement.dataset.sortKey];
    state.sort = state.sort === first ? second : first;
    savePrefs();
    render();
  });
});
document.querySelectorAll('[data-view]').forEach((control) => control.addEventListener('click', () => {
  state.view = control.dataset.view;
  savePrefs();
  render();
}));
document.querySelectorAll('[data-filter-group]').forEach((group) => {
  group.querySelectorAll('button').forEach((control) => control.addEventListener('click', () => {
    state[group.dataset.filterGroup] = control.dataset.value;
    savePrefs();
    render();
  }));
});
el.cleanableToggle.addEventListener('change', () => {
  state.cleanableOnly = el.cleanableToggle.checked;
  savePrefs();
  render();
});
el.inactiveToggle.addEventListener('change', () => {
  state.inactiveOnly = el.inactiveToggle.checked;
  savePrefs();
  render();
});
el.selectAll.addEventListener('change', () => {
  for (const project of visibleMatched) {
    if (el.selectAll.checked) state.selected.add(project.path);
    else state.selected.delete(project.path);
  }
  render();
});
$('#expand-all').addEventListener('click', () => setAllExpanded(true));
$('#collapse-all').addEventListener('click', () => setAllExpanded(false));
$('#clean-selected').addEventListener('click', () => {
  const chosen = selectedProjects();
  reviewCleanup(artifactPaths(chosen), `Clean ${plural(chosen.length, 'project')}`);
});
$('#copy-selected').addEventListener('click', () => {
  const paths = selectedProjects().map((project) => project.path);
  copyText(paths.join('\n'), `${plural(paths.length, 'path')} copied`);
});
$('#ignore-selected').addEventListener('click', () => setIgnored(true));
$('#unignore-selected').addEventListener('click', () => setIgnored(false));
$('#clear-selection').addEventListener('click', () => {
  state.selected.clear();
  render();
});
el.historyToggle.addEventListener('click', () => {
  const expanded = el.historyToggle.getAttribute('aria-expanded') === 'true';
  el.historyToggle.setAttribute('aria-expanded', String(!expanded));
  el.reclaimHistory.hidden = expanded;
});

document.addEventListener('keydown', (event) => {
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (event.key === '/' && !typing) {
    event.preventDefault();
    el.search.focus();
  }
  if (event.key === 'Escape' && !event.defaultPrevented && !document.querySelector('dialog[open]')) {
    state.selected.clear();
    el.search.blur();
    render();
  }
});

loadPrefs();
render();
loadSystem();
checkGithub();
loadProjects();
