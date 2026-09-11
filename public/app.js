const state = {
  projects: [],
  filter: 'code',
  query: '',
  sort: 'name',
  selected: new Set(),
  reclaimedTotalBytes: 0,
  lastScanReclaimedBytes: 0,
  reclaimHistory: []
};

const $ = (selector) => document.querySelector(selector);
const elements = {
  form: $('#scan-form'), root: $('#scan-root'), scanButton: $('#scan-button'), scanStatus: $('#scan-status'),
  list: $('#project-list'), template: $('#project-template'), empty: $('#empty-state'),
  search: $('#project-search'), sort: $('#project-sort'), selectAll: $('#select-all'),
  bulkBar: $('#bulk-bar'), selectedCount: $('#selected-count'), toast: $('#toast'),
  visibleCount: $('#visible-count'), projectCount: $('#project-count'), presentCount: $('#present-count'),
  missingCount: $('#missing-count'), reclaimableSize: $('#reclaimable-size'), totalSize: $('#total-size'),
  lastScan: $('#last-scan'), reclaimedTotal: $('#reclaimed-title'), reclaimedScan: $('#reclaimed-scan'),
  reclaimNote: $('#reclaim-note'), reclaimFill: $('#reclaim-fill'), historyToggle: $('#history-toggle'),
  reclaimHistory: $('#reclaim-history'), historyList: $('#history-list')
};

let toastTimer;

function formatBytes(bytes = 0) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1);
  const value = bytes / (1000 ** unit);
  return `${value.toFixed(unit > 1 ? 1 : 0)} ${units[unit]}`;
}

function relativeTime(iso) {
  if (!iso) return 'never';
  const elapsed = new Date(iso).getTime() - Date.now();
  const units = [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
  const seconds = Math.round(elapsed / 1000);
  const [unit, value] = units.find(([, size]) => Math.abs(seconds) >= size) || units.at(-1);
  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(Math.round(seconds / value), unit);
}

function matches(project) {
  const haystack = `${project.name} ${project.path} ${project.kind} ${project.scope} ${project.category}`.toLowerCase();
  if (state.query && !haystack.includes(state.query)) return false;
  if (state.filter === 'code') return !project.ignored && !project.contained && project.status === 'present' && project.category === 'code';
  if (state.filter === 'all') return !project.ignored;
  if (state.filter === 'repository') return !project.ignored && !project.contained && ['repository', 'documentation', 'config'].includes(project.category);
  if (state.filter === 'infrastructure') return !project.ignored && !project.contained && project.category === 'infrastructure';
  if (state.filter === 'content') return !project.ignored && !project.contained && ['data', 'documentation'].includes(project.category);
  if (state.filter === 'nested') return !project.ignored && project.contained;
  if (state.filter === 'missing') return !project.ignored && project.status === 'missing';
  if (state.filter === 'ignored') return project.ignored;
  return true;
}

function sortProjects(projects) {
  const sorted = [...projects];
  const text = (a, b, key) => String(a[key] || '').localeCompare(String(b[key] || ''), undefined, { sensitivity: 'base' });
  const total = (project) => project.totalSizeBytes ?? project.sizeBytes ?? 0;
  if (state.sort === 'size-desc') return sorted.sort((a, b) => total(b) - total(a) || text(a, b, 'name'));
  if (state.sort === 'size-asc') return sorted.sort((a, b) => total(a) - total(b) || text(a, b, 'name'));
  if (state.sort === 'cleanup') return sorted.sort((a, b) => (b.reclaimableSizeBytes || 0) - (a.reclaimableSizeBytes || 0) || text(a, b, 'name'));
  if (state.sort === 'recent') return sorted.sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0));
  if (state.sort === 'type') return sorted.sort((a, b) => text(a, b, 'kind') || text(a, b, 'name'));
  return sorted.sort((a, b) => text(a, b, 'name'));
}

function visibleProjects() {
  return sortProjects(state.projects.filter(matches));
}

function projectState(project) {
  if (project.ignored) return 'ignored';
  if (project.status === 'missing') return 'missing';
  if (project.change === 'new') return 'new';
  if (project.change === 'grew') return 'larger';
  if (project.change === 'shrunk') return 'smaller';
  if (project.status === 'unrecognized') return 'unrecognized';
  return 'no change';
}

function renderReclaim(potentialBytes) {
  const reclaimed = state.reclaimedTotalBytes;
  const eventCount = state.reclaimHistory.length;
  const denominator = reclaimed + potentialBytes;
  const progress = denominator ? Math.min(100, (reclaimed / denominator) * 100) : 0;
  elements.reclaimedTotal.textContent = formatBytes(reclaimed);
  elements.reclaimedScan.textContent = `+${formatBytes(state.lastScanReclaimedBytes)} this scan`;
  elements.reclaimFill.style.width = `${progress}%`;
  elements.reclaimNote.textContent = eventCount
    ? `${eventCount} reclaim event${eventCount === 1 ? '' : 's'} recorded locally`
    : 'Remove rebuildable files outside this app, then scan again to measure the space freed.';

  elements.historyList.replaceChildren();
  if (!eventCount) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = 'No reclaimed space recorded yet. The current scan is your baseline.';
    elements.historyList.append(empty);
    return;
  }
  state.reclaimHistory.slice(0, 8).forEach((event) => {
    const row = document.createElement('div');
    row.className = 'history-row';
    const project = document.createElement('div');
    project.className = 'history-project';
    project.textContent = event.projectName;
    const reason = document.createElement('small');
    reason.textContent = `${event.reason === 'project-removed' ? 'folder removed' : 'size reduced'} · ${relativeTime(event.at)}`;
    project.append(reason);
    const amount = document.createElement('span');
    amount.className = 'history-amount';
    amount.textContent = `+${formatBytes(event.bytes)}`;
    row.append(project, amount);
    elements.historyList.append(row);
  });
}

function render() {
  const visible = visibleProjects();
  const active = state.projects.filter((project) => !project.ignored);
  const present = active.filter((project) => project.status === 'present');

  elements.visibleCount.textContent = visible.length;
  elements.projectCount.textContent = state.projects.length;
  elements.presentCount.textContent = present.length;
  elements.missingCount.textContent = active.filter((project) => project.status === 'missing').length;
  const topLevel = present.filter((project) => !project.contained);
  const potentialBytes = topLevel.reduce((sum, project) => sum + (project.reclaimableSizeBytes || 0), 0);
  elements.totalSize.textContent = formatBytes(topLevel.reduce((sum, project) => sum + (project.totalSizeBytes ?? project.sizeBytes ?? 0), 0));
  elements.reclaimableSize.textContent = formatBytes(potentialBytes);
  renderReclaim(potentialBytes);
  elements.list.replaceChildren();
  elements.empty.hidden = visible.length > 0;

  visible.forEach((project, index) => {
    const row = elements.template.content.firstElementChild.cloneNode(true);
    const selected = state.selected.has(project.path);
    row.style.animationDelay = `${Math.min(index * 12, 150)}ms`;
    row.classList.toggle('is-selected', selected);
    row.classList.toggle('is-missing', project.status === 'missing');
    row.classList.toggle('is-ignored', project.ignored);

    const checkbox = row.querySelector('input');
    checkbox.checked = selected;
    checkbox.setAttribute('aria-label', `Select ${project.name}`);
    checkbox.addEventListener('change', () => toggleSelection(project.path, checkbox.checked));

    row.querySelector('h3').textContent = project.name;
    row.querySelector('.scope').textContent = project.contained ? 'nested' : project.category || project.scope || 'project';
    row.querySelector('.kind').textContent = project.kind;
    row.querySelector('.size').textContent = formatBytes(project.totalSizeBytes ?? project.sizeBytes);
    const cleanup = row.querySelector('.cleanup');
    cleanup.textContent = formatBytes(project.reclaimableSizeBytes || 0);
    cleanup.tabIndex = 0;
    cleanup.dataset.tooltip = `Dependencies ${formatBytes(project.dependencySizeBytes)} · builds ${formatBytes(project.generatedSizeBytes)} · caches ${formatBytes(project.cacheSizeBytes)}. Source and Git are excluded.`;
    cleanup.setAttribute('aria-label', `${formatBytes(project.reclaimableSizeBytes || 0)} rebuildable: ${cleanup.dataset.tooltip}`);
    row.querySelector('.state span').textContent = projectState(project);

    const pathButton = row.querySelector('.copy-path');
    pathButton.textContent = project.path;
    pathButton.title = `Copy ${project.path}`;
    pathButton.addEventListener('click', () => copyText(project.path, `${project.name} path copied`));

    const openButton = row.querySelector('.open-button');
    openButton.setAttribute('aria-label', `Open ${project.name} folder`);
    openButton.addEventListener('click', () => openProject(project));
    elements.list.append(row);
  });

  updateSelectionUI(visible);
}

function updateSelectionUI(visible = visibleProjects()) {
  const selectedVisible = visible.filter((project) => state.selected.has(project.path));
  elements.selectedCount.textContent = state.selected.size;
  elements.bulkBar.hidden = state.selected.size === 0;
  elements.selectAll.checked = visible.length > 0 && selectedVisible.length === visible.length;
  elements.selectAll.indeterminate = selectedVisible.length > 0 && selectedVisible.length < visible.length;
}

function toggleSelection(projectPath, selected) {
  if (selected) state.selected.add(projectPath);
  else state.selected.delete(projectPath);
  render();
}

function applyStore(store) {
  state.projects = store.projects || [];
  state.reclaimedTotalBytes = store.reclaimedTotalBytes || 0;
  state.lastScanReclaimedBytes = store.lastScanReclaimedBytes || 0;
  state.reclaimHistory = store.reclaimHistory || [];
  for (const selected of state.selected) {
    if (!state.projects.some((project) => project.path === selected)) state.selected.delete(selected);
  }
  elements.root.value = store.scanRoot || '';
  elements.lastScan.textContent = store.lastScanAt
    ? `scanned ${relativeTime(store.lastScanAt)} · ${store.inspectedDirectories || 0} dirs · ${((store.scanDurationMs || 0) / 1000).toFixed(1)}s`
    : 'never scanned';
  render();
}

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'request failed');
  return data;
}

function notify(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', isError);
  elements.toast.classList.add('is-visible');
  toastTimer = setTimeout(() => elements.toast.classList.remove('is-visible'), 2200);
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    notify(message);
  } catch {
    notify('clipboard access failed', true);
  }
}

async function loadProjects() {
  try { applyStore(await request('/api/projects')); }
  catch (error) { notify(error.message, true); }
}

async function runScan(event) {
  event.preventDefault();
  elements.scanButton.disabled = true;
  elements.scanButton.classList.add('is-scanning');
  elements.scanStatus.classList.remove('error');
  elements.scanStatus.textContent = 'scanning…';
  try {
    const store = await request('/api/scan', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root: elements.root.value.trim() })
    });
    state.selected.clear();
    applyStore(store);
    elements.scanStatus.textContent = `${store.projects.filter((project) => project.status === 'present').length} found`;
    notify(store.lastScanReclaimedBytes ? `${formatBytes(store.lastScanReclaimedBytes)} reclaimed` : 'index updated');
  } catch (error) {
    elements.scanStatus.textContent = 'scan failed';
    elements.scanStatus.classList.add('error');
    notify(error.message, true);
  } finally {
    elements.scanButton.disabled = false;
    elements.scanButton.classList.remove('is-scanning');
  }
}

async function openProject(project) {
  try {
    await request('/api/open', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: project.path })
    });
    notify(`opened ${project.name}`);
  } catch (error) { notify(error.message, true); }
}

async function setIgnored(ignored) {
  if (!state.selected.size) return;
  try {
    const store = await request('/api/ignore', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [...state.selected], ignored })
    });
    const count = state.selected.size;
    state.selected.clear();
    applyStore(store);
    notify(`${count} project${count === 1 ? '' : 's'} ${ignored ? 'ignored' : 'restored'}`);
  } catch (error) { notify(error.message, true); }
}

elements.form.addEventListener('submit', runScan);
elements.search.addEventListener('input', (event) => { state.query = event.target.value.trim().toLowerCase(); render(); });
elements.sort.addEventListener('change', (event) => { state.sort = event.target.value; render(); });
elements.selectAll.addEventListener('change', () => {
  for (const project of visibleProjects()) {
    if (elements.selectAll.checked) state.selected.add(project.path);
    else state.selected.delete(project.path);
  }
  render();
});

document.querySelectorAll('.filter').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelector('.filter.is-active')?.classList.remove('is-active');
    button.classList.add('is-active');
    state.filter = button.dataset.filter;
    render();
  });
});

$('#copy-selected').addEventListener('click', () => {
  const paths = state.projects.filter((project) => state.selected.has(project.path)).map((project) => project.path);
  copyText(paths.join('\n'), `${paths.length} paths copied`);
});
$('#ignore-selected').addEventListener('click', () => setIgnored(true));
$('#unignore-selected').addEventListener('click', () => setIgnored(false));
$('#clear-selection').addEventListener('click', () => { state.selected.clear(); render(); });
elements.historyToggle.addEventListener('click', () => {
  const expanded = elements.historyToggle.getAttribute('aria-expanded') === 'true';
  elements.historyToggle.setAttribute('aria-expanded', String(!expanded));
  elements.reclaimHistory.hidden = expanded;
});

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    event.preventDefault(); elements.search.focus();
  }
  if (event.key === 'Escape') { state.selected.clear(); elements.search.blur(); render(); }
});

loadProjects();
