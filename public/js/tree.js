import { isInside, tildify } from './format.js';

const SMALL_ARTIFACT_BYTES = 100_000;

export function projectSize(project) {
  return project.totalSizeBytes ?? project.sizeBytes ?? 0;
}

export function projectActiveMs(project) {
  return project.lastActiveAt ? new Date(project.lastActiveAt).getTime() : 0;
}

function createNode(path, segment) {
  return { key: path, path, segment, kind: 'folder', project: null, context: false, children: new Map(), parent: null };
}

// Builds the folder hierarchy that leads to the given projects.
// `matched` are the filter results. `context` are ancestor projects that did not
// match but still contain a match; they stay in the tree (dimmed) so nesting is
// shown truthfully instead of floating nested projects loose.
export function buildTree(matched, context = []) {
  const root = createNode('/', '');
  root.isRoot = true;
  const insert = (project, isContext) => {
    let node = root;
    let current = '';
    for (const segment of project.path.split('/').filter(Boolean)) {
      current += `/${segment}`;
      let child = node.children.get(segment);
      if (!child) {
        child = createNode(current, segment);
        child.parent = node;
        node.children.set(segment, child);
      }
      node = child;
    }
    node.kind = 'project';
    node.project = project;
    node.context = isContext;
  };
  for (const project of context) insert(project, true);
  for (const project of matched) insert(project, false);
  toArrays(root);
  compress(root);
  aggregate(root);
  return root;
}

function toArrays(node) {
  node.children = [...node.children.values()];
  node.children.forEach(toArrays);
}

// Folder chains with a single folder child collapse into one row
// ("side-projects/Addtech"), like compact folders in an editor. Projects are
// never merged, so every project keeps its own row.
function compress(node) {
  node.children = node.children.map((child) => {
    let merged = child;
    while (merged.kind === 'folder' && merged.children.length === 1 && merged.children[0].kind === 'folder') {
      const only = merged.children[0];
      only.segment = `${merged.segment}/${only.segment}`;
      merged = only;
    }
    merged.parent = node;
    return merged;
  });
  node.children.forEach(compress);
}

// A project's own measurement already includes everything nested inside it, so
// project nodes report their own size instead of adding up their children.
function aggregate(node) {
  const totals = { projects: 0, matched: 0, missing: 0, diskBytes: 0, rebuildableBytes: 0, lastActiveMs: 0 };
  for (const child of node.children) {
    const childTotals = aggregate(child);
    totals.projects += childTotals.projects;
    totals.matched += childTotals.matched;
    totals.missing += childTotals.missing;
    totals.diskBytes += childTotals.diskBytes;
    totals.rebuildableBytes += childTotals.rebuildableBytes;
    totals.lastActiveMs = Math.max(totals.lastActiveMs, childTotals.lastActiveMs);
  }
  if (node.project) {
    const project = node.project;
    totals.projects += 1;
    if (!node.context) totals.matched += 1;
    if (project.status === 'missing') {
      totals.missing += 1;
    } else {
      totals.diskBytes = projectSize(project);
      totals.rebuildableBytes = project.reclaimableSizeBytes || 0;
    }
    totals.lastActiveMs = Math.max(totals.lastActiveMs, projectActiveMs(project));
  }
  node.totals = totals;
  return totals;
}

export function displayName(node) {
  if (node.project) return node.project.name;
  return node.parent?.isRoot ? tildify(node.path) : node.segment;
}

export function sortTree(node, compare) {
  node.children.sort(compare);
  node.children.forEach((child) => sortTree(child, compare));
}

// Rebuildable folders that belong to this project itself, not to a nested
// project shown beneath it (those appear under the nested project instead).
export function ownArtifacts(node) {
  const artifacts = node.project?.artifacts || [];
  if (!artifacts.length) return [];
  const nested = [];
  const collect = (current) => {
    for (const child of current.children) {
      if (child.project) nested.push(child.path);
      else collect(child);
    }
  };
  collect(node);
  return artifacts
    .filter((artifact) => !nested.some((path) => isInside(artifact.path, path)))
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
}

export function subtreeProjectNodes(node) {
  const found = [];
  const walk = (current) => {
    if (current.project) found.push(current);
    current.children.forEach(walk);
  };
  walk(node);
  return found;
}

export function allNodes(root) {
  const found = [];
  const walk = (node) => {
    for (const child of node.children) {
      found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

// Turns the tree into the rows currently visible. Bars compare each row with its
// siblings, so every level of the hierarchy shows where its own space goes.
export function flattenTree(root, { isExpanded, forceOpen = false }) {
  const rows = [];
  const walk = (node, depth) => {
    const largest = Math.max(1, ...node.children.map((child) => child.totals.rebuildableBytes));
    for (const child of node.children) {
      const artifacts = child.project && child.project.status !== 'missing' ? ownArtifacts(child) : [];
      const expandable = child.children.length > 0 || artifacts.length > 0;
      const opened = forceOpen && (child.kind === 'folder' || child.children.length > 0);
      const expanded = expandable && (opened || isExpanded(child));
      rows.push({ kind: child.kind, node: child, depth, expandable, expanded, share: child.totals.rebuildableBytes / largest });
      if (!expanded) continue;
      const visible = artifacts.filter((artifact) => artifact.sizeBytes >= SMALL_ARTIFACT_BYTES);
      const small = artifacts.filter((artifact) => artifact.sizeBytes < SMALL_ARTIFACT_BYTES);
      const largestArtifact = Math.max(1, ...visible.map((artifact) => artifact.sizeBytes));
      for (const artifact of visible) {
        rows.push({ kind: 'artifact', node: child, artifact, depth: depth + 1, share: artifact.sizeBytes / largestArtifact });
      }
      if (small.length) rows.push({ kind: 'more', node: child, artifacts: small, depth: depth + 1 });
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}
