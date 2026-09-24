import { activityLevel, daysIdle } from './activity.js';
import { badge, button, element, icon, setIcon } from './dom.js';
import { formatBytes, formatDate, plural, shortAge, tildify } from './format.js';
import { renderGitCell } from './git-view.js';
import { fileManager } from './platform.js';
import { displayName, projectActiveMs, projectSize, subtreeProjectNodes } from './tree.js';

const BUCKET_NAMES = { dependency: 'dependencies', generated: 'build output', cache: 'cache' };
const STATE_TONES = { missing: 'danger', cleaned: 'accent', new: 'accent', larger: 'warn', unrecognized: 'warn' };
const template = document.querySelector('#row-template');

export function projectState(project) {
  if (project.ignored) return 'ignored';
  if (project.status === 'missing') return 'missing';
  if (project.change === 'cleaned') return 'cleaned';
  if (project.change === 'new') return 'new';
  if (project.change === 'grew') return 'larger';
  if (project.change === 'shrunk') return 'smaller';
  if (project.status === 'unrecognized') return 'unrecognized';
  return 'no change';
}

// Rebuildable folders of every present project in a set, without duplicates
// (a parent project's list already includes its nested projects' folders).
export function artifactPaths(projects) {
  const paths = new Set();
  for (const project of projects) {
    if (project.status === 'missing') continue;
    for (const artifact of project.artifacts || []) paths.add(artifact.path);
  }
  return [...paths];
}

export function renderRows(container, rows, ctx) {
  const fragment = document.createDocumentFragment();
  for (const row of rows) {
    if (row.kind === 'folder') fragment.append(folderRow(row, ctx));
    else if (row.kind === 'project') fragment.append(projectRow(row, ctx));
    else if (row.kind === 'artifact') fragment.append(artifactRow(row, ctx));
    else fragment.append(moreRow(row));
  }
  container.replaceChildren(fragment);
  const focusTarget = (ctx.focusKey && [...container.children].find((row) => row.dataset.key === ctx.focusKey)) ||
    container.firstElementChild;
  if (focusTarget) {
    focusTarget.tabIndex = 0;
    if (ctx.focusKey && ctx.restoreFocus) focusTarget.focus({ preventScroll: false });
  }
}

function baseRow(row, kind) {
  const node = template.content.firstElementChild.cloneNode(true);
  node.classList.add(`row-${kind}`);
  node.style.setProperty('--depth', String(row.depth));
  node.setAttribute('aria-level', String(row.depth + 1));
  return {
    rowEl: node,
    cells: {
      check: node.querySelector('.cell-check'),
      nameCell: node.querySelector('.cell-name'),
      disclosure: node.querySelector('.disclosure'),
      icon: node.querySelector('.node-icon'),
      name: node.querySelector('.name'),
      badges: node.querySelector('.badges'),
      sub: node.querySelector('.sub-line'),
      type: node.querySelector('.cell-type'),
      disk: node.querySelector('.cell-disk'),
      rebuild: node.querySelector('.cell-rebuild'),
      active: node.querySelector('.cell-active'),
      git: node.querySelector('.cell-git'),
      actions: node.querySelector('.cell-actions')
    }
  };
}

function setupDisclosure(rowEl, cells, row, ctx) {
  if (!row.expandable || ctx.mode === 'list') {
    cells.disclosure.classList.add('is-leaf');
    return;
  }
  const label = `${row.expanded ? 'Collapse' : 'Expand'} ${displayName(row.node)}`;
  rowEl.setAttribute('aria-expanded', String(row.expanded));
  cells.disclosure.setAttribute('aria-expanded', String(row.expanded));
  cells.disclosure.setAttribute('aria-label', label);
  cells.nameCell.addEventListener('click', () => ctx.onToggle(row.node));
}

function setupCheckbox(rowEl, cells, paths, ctx, label) {
  const input = cells.check.querySelector('input');
  if (!paths.length) {
    cells.check.replaceChildren();
    return;
  }
  const selectedCount = paths.filter((path) => ctx.selected.has(path)).length;
  input.checked = selectedCount === paths.length;
  input.indeterminate = selectedCount > 0 && selectedCount < paths.length;
  input.setAttribute('aria-label', label);
  input.addEventListener('click', (event) => event.stopPropagation());
  input.addEventListener('change', () => ctx.onSelect(paths, input.checked));
  rowEl.classList.toggle('is-selected', input.checked);
}

function fillRebuild(cell, bytes, share) {
  const value = cell.querySelector('.value');
  value.textContent = formatBytes(bytes);
  value.classList.toggle('is-zero', !bytes);
  cell.querySelector('.bar i').style.setProperty('--share', Math.max(0, Math.min(1, share || 0)).toFixed(3));
}

function fillActivity(cell, timeMs) {
  const level = activityLevel(daysIdle(timeMs));
  cell.querySelector('.dot').dataset.level = level;
  cell.querySelector('.value').textContent = shortAge(timeMs);
  cell.title = timeMs
    ? `Last change ${formatDate(timeMs)}${level === 'unknown' ? '' : ` · ${level}`}`
    : 'Scan again to record when this last changed';
}

function folderRow(row, ctx) {
  const { rowEl, cells } = baseRow(row, 'folder');
  const { node } = row;
  const name = displayName(node);
  rowEl.dataset.key = node.key;
  setIcon(cells.icon, 'folder');
  cells.name.textContent = name;
  cells.name.title = tildify(node.path);
  setupDisclosure(rowEl, cells, row, ctx);

  const projects = subtreeProjectNodes(node).map((child) => child.project);
  setupCheckbox(rowEl, cells, projects.map((project) => project.path), ctx, `Select every project in ${name}`);
  cells.type.textContent = plural(node.totals.matched, 'project');
  cells.disk.textContent = formatBytes(node.totals.diskBytes);
  fillRebuild(cells.rebuild, node.totals.rebuildableBytes, row.share);
  fillActivity(cells.active, node.totals.lastActiveMs);

  const paths = artifactPaths(projects);
  cells.actions.append(
    button('browse', { title: `Browse ${tildify(node.path)}`, onClick: () => ctx.onBrowse(node.path) }),
    button('clean', {
      className: 'row-action is-clean',
      disabled: !paths.length || ctx.busy,
      title: paths.length ? `Review the rebuildable folders of ${plural(projects.length, 'project')}` : 'Nothing rebuildable found here',
      onClick: () => ctx.onClean(paths, `Clean ${name}`)
    })
  );
  return rowEl;
}

function projectRow(row, ctx) {
  const { rowEl, cells } = baseRow(row, 'project');
  const project = row.node.project;
  const missing = project.status === 'missing';
  rowEl.dataset.key = row.node.key;
  rowEl.dataset.category = project.category || '';
  rowEl.classList.toggle('is-context', Boolean(row.node.context));
  rowEl.classList.toggle('is-missing', missing);
  rowEl.classList.toggle('is-ignored', Boolean(project.ignored));
  setIcon(cells.icon, 'project');
  cells.name.textContent = project.name;
  cells.name.title = tildify(project.path);

  const state = projectState(project);
  const quietStates = ctx.mode === 'list' ? ['no change'] : ['no change', 'new', 'larger', 'smaller'];
  if (!quietStates.includes(state)) cells.badges.append(badge(state, STATE_TONES[state]));
  if (row.node.context) {
    cells.name.title = `${tildify(project.path)}\nShown dimmed because it does not match the filters but contains projects that do.`;
  }
  if (ctx.mode === 'list') {
    cells.sub.append(button(tildify(project.path), {
      className: 'copy-path',
      title: `Copy ${project.path}`,
      onClick: () => ctx.onCopy(project.path)
    }));
  }
  setupDisclosure(rowEl, cells, row, ctx);
  setupCheckbox(rowEl, cells, [project.path], ctx, `Select ${project.name}`);

  cells.type.textContent = project.kind || '';
  cells.disk.textContent = missing ? '—' : formatBytes(projectSize(project));
  fillRebuild(cells.rebuild, missing ? 0 : project.reclaimableSizeBytes || 0, row.share);
  fillActivity(cells.active, projectActiveMs(project));
  renderGitCell(cells.git, project, ctx.gitFor(project), { onOpen: ctx.onGit });

  if (!missing) {
    const paths = artifactPaths([project]);
    const title = !project.artifacts
      ? 'Scan again to find this project’s rebuildable folders'
      : paths.length ? `Review ${formatBytes(project.reclaimableSizeBytes)} of rebuildable files` : 'Nothing rebuildable here';
    cells.actions.append(
      button('browse', { title: `Browse ${tildify(project.path)}`, onClick: () => ctx.onBrowse(project.path) }),
      button('clean', {
        className: 'row-action is-clean',
        disabled: !paths.length || ctx.busy,
        title,
        onClick: () => ctx.onClean(paths, `Clean ${project.name}`)
      }),
      openButton(project, ctx)
    );
  }
  return rowEl;
}

function openButton(project, ctx) {
  const node = element('button', {
    className: 'row-action is-open is-icon',
    title: `Open in ${fileManager()}`,
    attrs: { type: 'button', 'aria-label': `Open ${project.name} in ${fileManager()}` }
  }, [icon('reveal')]);
  node.addEventListener('click', (event) => {
    event.stopPropagation();
    ctx.onOpen(project);
  });
  return node;
}

function artifactRow(row, ctx) {
  const { rowEl, cells } = baseRow(row, 'artifact');
  const { artifact } = row;
  rowEl.dataset.key = artifact.path;
  setIcon(cells.icon, 'artifact');
  cells.disclosure.classList.add('is-leaf');
  cells.check.replaceChildren();
  cells.name.textContent = artifact.relativePath;
  cells.name.title = tildify(artifact.path);
  if (artifact.ambiguous) {
    const verify = badge('verify', 'warn');
    verify.title = `Some projects keep hand-written files in a folder named "${artifact.name}". The review checks Git before selecting it.`;
    cells.badges.append(verify);
  }
  cells.sub.append(artifact.label);
  if (artifact.restore?.command) {
    cells.sub.append(' · restore ', element('code', { text: artifact.restore.command }));
  } else if (artifact.restore?.note) {
    cells.sub.append(` · ${artifact.restore.note}`);
  }
  cells.type.textContent = BUCKET_NAMES[artifact.bucket] || artifact.bucket;
  fillRebuild(cells.rebuild, artifact.sizeBytes, row.share);
  cells.active.replaceChildren();
  cells.actions.append(
    button('browse', { title: `Browse ${tildify(artifact.path)}`, onClick: () => ctx.onBrowse(artifact.path) }),
    button('delete', {
      className: 'row-action is-clean',
      disabled: ctx.busy,
      title: `Review deleting ${artifact.relativePath}`,
      onClick: () => ctx.onClean([artifact.path], `Delete ${artifact.relativePath}`)
    })
  );
  return rowEl;
}

function moreRow(row) {
  const { rowEl, cells } = baseRow(row, 'more');
  const total = row.artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
  rowEl.dataset.key = `${row.node.key}#small`;
  setIcon(cells.icon, 'artifact');
  cells.disclosure.classList.add('is-leaf');
  cells.check.replaceChildren();
  cells.name.textContent = `${plural(row.artifacts.length, 'smaller folder')} under 100 KB`;
  const names = row.artifacts.slice(0, 4).map((artifact) => artifact.relativePath).join(', ');
  cells.sub.textContent = `${names}${row.artifacts.length > 4 ? ', …' : ''} · included when you clean this project`;
  fillRebuild(cells.rebuild, total, 0);
  cells.active.replaceChildren();
  return rowEl;
}

// Treegrid keyboard support: arrows move and open or close rows, Space selects,
// Enter browses the focused row.
export function enableKeyboard(container, ctx) {
  container.addEventListener('keydown', (event) => {
    const row = event.target.closest?.('.project-row');
    if (!row || event.target !== row) return;
    const rows = [...container.querySelectorAll('.project-row')];
    const index = rows.indexOf(row);
    const level = Number(row.getAttribute('aria-level'));
    const expanded = row.getAttribute('aria-expanded');
    const focusRow = (target) => {
      if (!target) return;
      for (const candidate of rows) candidate.tabIndex = -1;
      target.tabIndex = 0;
      target.focus();
    };
    const handled = () => event.preventDefault();
    switch (event.key) {
      case 'ArrowDown': handled(); focusRow(rows[index + 1]); break;
      case 'ArrowUp': handled(); focusRow(rows[index - 1]); break;
      case 'Home': handled(); focusRow(rows[0]); break;
      case 'End': handled(); focusRow(rows.at(-1)); break;
      case 'ArrowRight':
        handled();
        if (expanded === 'false') ctx.onToggleKey(row.dataset.key);
        else if (expanded === 'true') focusRow(rows[index + 1]);
        break;
      case 'ArrowLeft':
        handled();
        if (expanded === 'true') ctx.onToggleKey(row.dataset.key);
        else focusRow(rows.slice(0, index).reverse().find((candidate) => Number(candidate.getAttribute('aria-level')) === level - 1));
        break;
      case ' ':
        handled();
        ctx.rememberFocus(row.dataset.key);
        row.querySelector('.cell-check input')?.click();
        break;
      case 'Enter':
        handled();
        row.querySelector('.cell-actions .row-action')?.click();
        break;
      default:
    }
  });
}
