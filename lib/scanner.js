const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { STORE_PATH } = require('./config');
const { isInside } = require('./paths');
const rules = require('./rules');
const { STORE_VERSION, readStore, writeStore, withStore } = require('./store');

const BUCKET_KEYS = {
  source: 'sourceSizeBytes',
  dependency: 'dependencySizeBytes',
  generated: 'generatedSizeBytes',
  cache: 'cacheSizeBytes',
  vcs: 'vcsSizeBytes'
};
const SIZE_KEYS = ['totalSizeBytes', ...Object.values(BUCKET_KEYS)];

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function markerDetails(marker) {
  if (rules.PROJECT_MARKERS.has(marker)) {
    const [kind, category] = rules.PROJECT_MARKERS.get(marker);
    return { kind, category };
  }
  const wildcard = rules.WILDCARD_MARKERS.find(([pattern]) => pattern.test(marker));
  return wildcard ? { kind: wildcard[1], category: wildcard[2] } : null;
}

function hasRepositoryMarker(markers) {
  return markers.some((marker) => ['.git', '.git-bare', '.hg', '.svn'].includes(marker));
}

function classifyMarkers(markers, entries = []) {
  const meaningful = markers.filter((marker) => marker !== '.git');
  const details = meaningful.map(markerDetails).filter(Boolean);
  if (details.length) {
    const preferred = details.find((item) => item.category === 'code') || details[0];
    return preferred;
  }

  const names = entries.map((entry) => entry.name);
  const hasSource = names.some((name) => rules.SOURCE_EXTENSIONS.has(path.extname(name).toLowerCase())) ||
    names.some((name) => ['src', 'app', 'lib', 'cmd'].includes(name));
  if (hasSource) return { kind: 'Source', category: 'code' };
  if (names.some((name) => /^(docs?|readme)/i.test(name))) return { kind: 'Docs', category: 'documentation' };
  if (names.some((name) => /^\.(zsh|bash|vim|config)|dotfiles/i.test(name))) return { kind: 'Config', category: 'config' };
  return { kind: 'Git', category: 'repository' };
}

function isExcludedProject(projectPath, scanRoot) {
  return projectPath.split(path.sep).some((part) => rules.DISCOVERY_SKIP_DIRS.has(part)) ||
    rules.isSystemPath(projectPath, scanRoot);
}

async function refreshPresence(store) {
  store.projects = store.projects.filter((project) => !isExcludedProject(project.path, store.scanRoot || path.sep));
  const paths = new Set(store.projects.map((project) => project.path));
  store.version = STORE_VERSION;
  store.reclaimedTotalBytes = store.reclaimedTotalBytes || 0;
  store.lastScanReclaimedBytes = store.lastScanReclaimedBytes || 0;
  store.reclaimHistory = store.reclaimHistory || [];
  store.projects = await Promise.all(store.projects.map(async (project) => {
    const present = await pathExists(project.path);
    const markers = project.markers || [];
    const parentProjectPath = [...paths]
      .filter((candidate) => candidate !== project.path && isInside(project.path, candidate))
      .sort((a, b) => b.length - a.length)[0] || null;
    const contained = Boolean(parentProjectPath);
    const repository = hasRepositoryMarker(markers);
    const nested = !repository && contained;
    const inferred = project.category ? { kind: project.kind, category: project.category } : classifyMarkers(markers);
    const normalized = {
      ...project,
      ...inferred,
      ignored: Boolean(project.ignored),
      contained,
      nested,
      scope: repository ? 'repository' : nested ? 'nested' : 'standalone',
      parentProjectPath
    };
    if (present) return { ...normalized, status: project.status === 'unrecognized' ? 'unrecognized' : 'present', missingSince: null };
    return { ...normalized, status: 'missing', missingSince: project.missingSince || new Date().toISOString() };
  }));
  return store;
}

async function detectProjects(root, maxDepth = 8) {
  const found = [];
  let inspectedDirectories = 0;

  async function visit(directory, depth, ancestorProjectPath = null) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
      inspectedDirectories += 1;
    } catch {
      return;
    }

    const names = new Set(entries.map((entry) => entry.name));
    const exactMarkers = [...rules.PROJECT_MARKERS.keys()].filter((marker) => names.has(marker));
    const wildcardMarkers = entries.map((entry) => entry.name)
      .filter((name) => rules.WILDCARD_MARKERS.some(([pattern]) => pattern.test(name)));
    const syntheticMarkers = [];
    if (names.has('HEAD') && names.has('objects') && names.has('refs')) syntheticMarkers.push('.git-bare');
    if (names.has('Assets') && names.has('ProjectSettings')) syntheticMarkers.push('Unity project');
    const markers = [...new Set([...exactMarkers, ...wildcardMarkers, ...syntheticMarkers])];
    let nextAncestor = ancestorProjectPath;
    if (markers.length) {
      const hasGit = hasRepositoryMarker(markers);
      const contained = Boolean(ancestorProjectPath);
      const nested = !hasGit && contained;
      const classification = classifyMarkers(markers, entries);
      found.push({
        path: directory,
        name: path.basename(directory),
        ...classification,
        markers,
        contained,
        nested,
        scope: hasGit ? 'repository' : nested ? 'nested' : 'standalone',
        parentProjectPath: ancestorProjectPath
      });
      nextAncestor = directory;
    }

    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && !rules.DISCOVERY_SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.'))
      .map((entry) => path.join(directory, entry.name))
      .filter((child) => !rules.DISCOVERY_SKIP_PATH_SET.has(child))
      .map((child) => visit(child, depth + 1, nextAncestor)));
  }

  await visit(root, 0);
  return { found, inspectedDirectories };
}

// Walks a folder once and returns its disk usage split by what the bytes are:
// source, dependencies, generated output, caches, and version-control metadata.
// Along the way it records every rebuildable folder it enters (an "artifact"),
// the Git repositories it contains, and the newest source-file change.
// `rootBucket` classifies the whole walk when the root is itself inside a
// rebuildable folder (measuring node_modules/foo, for example).
async function directoryBreakdown(root, { rootBucket = 'source', signal } = {}) {
  const sizes = Object.fromEntries(SIZE_KEYS.map((key) => [key, 0]));
  const counts = { fileCount: 0, dirCount: 0, linkedBytes: 0 };
  const artifacts = [];
  const repositories = [];
  let newestSourceMs = 0;

  async function visit(directory, bucket, artifact, context) {
    if (signal?.aborted) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    counts.dirCount += 1;
    const names = bucket === 'source' ? new Set(entries.map((entry) => entry.name)) : null;
    const childContext = names ? rules.inheritContext(context, names) : context;

    await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entryPath === STORE_PATH || entryPath === `${STORE_PATH}.tmp`) return;
      let nextBucket = bucket;
      let nextArtifact = artifact;
      if (bucket === 'source') {
        if (entry.name === '.git') {
          nextBucket = 'vcs';
          repositories.push(directory);
        } else if (entry.isDirectory()) {
          const rule = rules.matchArtifactRule(entry.name, names);
          if (rule) {
            nextBucket = rule.bucket;
            nextArtifact = {
              path: entryPath,
              relativePath: path.relative(root, entryPath),
              name: entry.name,
              bucket: rule.bucket,
              label: rule.label,
              ambiguous: Boolean(rule.ambiguous),
              restore: rules.restoreInfo(rule, names, childContext),
              sizeBytes: 0,
              fileCount: 0,
              linkedBytes: 0
            };
            artifacts.push(nextArtifact);
          }
        }
      }
      if (entry.isDirectory()) return visit(entryPath, nextBucket, nextArtifact, childContext);
      if (!entry.isFile()) return;
      try {
        const stats = await fs.lstat(entryPath);
        const diskBytes = Number.isFinite(stats.blocks) ? stats.blocks * 512 : stats.size;
        const linked = stats.nlink > 1 ? diskBytes : 0;
        sizes.totalSizeBytes += diskBytes;
        sizes[BUCKET_KEYS[nextBucket]] += diskBytes;
        counts.fileCount += 1;
        counts.linkedBytes += linked;
        if (nextArtifact) {
          nextArtifact.sizeBytes += diskBytes;
          nextArtifact.fileCount += 1;
          nextArtifact.linkedBytes += linked;
        }
        if (nextBucket === 'source' && entry.name !== '.DS_Store' && stats.mtimeMs > newestSourceMs) {
          newestSourceMs = stats.mtimeMs;
        }
      } catch {}
    }));
  }

  await visit(root, rootBucket, null, {});

  // A commit, checkout, or pull touches the HEAD reflog even when no source file
  // changes, so it counts as activity too.
  let lastActiveMs = newestSourceMs;
  try {
    const head = await fs.stat(path.join(root, '.git', 'logs', 'HEAD'));
    lastActiveMs = Math.max(lastActiveMs, head.mtimeMs);
  } catch {}

  return {
    ...sizes,
    reclaimableSizeBytes: sizes.dependencySizeBytes + sizes.generatedSizeBytes + sizes.cacheSizeBytes,
    ...counts,
    lastActiveAt: lastActiveMs ? new Date(lastActiveMs).toISOString() : null,
    artifacts: artifacts.sort((a, b) => b.sizeBytes - a.sizeBytes),
    repositories: repositories.sort(),
    aborted: Boolean(signal?.aborted)
  };
}

function createReclaimEvent(previous, current, now, id) {
  const beforeBytes = previous?.totalSizeBytes ?? previous?.sizeBytes;
  const afterBytes = current.totalSizeBytes ?? current.sizeBytes ?? 0;
  const bytes = beforeBytes == null ? 0 : beforeBytes - afterBytes;
  if (previous?.status !== 'present' || current.contained || bytes < 4096) return null;
  return {
    id,
    at: now,
    projectPath: current.path,
    projectName: current.name,
    bytes,
    reason: afterBytes === 0 ? 'project-removed' : 'size-reduced',
    beforeBytes,
    afterBytes
  };
}

async function scan(scanRoot) {
  const root = path.resolve(scanRoot || os.homedir());
  const stats = await fs.stat(root);
  if (!stats.isDirectory()) throw new Error('The scan path must be a directory.');

  const startedAt = Date.now();
  const { found, inspectedDirectories } = await detectProjects(root);

  const measured = [];
  for (let index = 0; index < found.length; index += 2) {
    const group = found.slice(index, index + 2);
    measured.push(...await Promise.all(group.map(async (project) => {
      const { repositories, dirCount, aborted, ...breakdown } = await directoryBreakdown(project.path);
      return { ...project, ...breakdown };
    })));
  }

  // Walking the disk happens outside the store lock; merging with the previous
  // inventory happens inside it, against the latest saved state.
  return withStore(async () => {
    const previous = await readStore();
    const byPath = new Map(previous.projects.map((project) => [project.path, project]));
    const now = new Date().toISOString();

    const seen = new Set(measured.map((project) => project.path));
    const currentProjects = measured.map((project) => {
      const old = byPath.get(project.path);
      const oldTotal = old?.totalSizeBytes ?? old?.sizeBytes;
      const change = !old ? 'new' : project.totalSizeBytes > oldTotal ? 'grew' : project.totalSizeBytes < oldTotal ? 'shrunk' : 'unchanged';
      return {
        ...project,
        sizeBytes: project.totalSizeBytes,
        status: 'present',
        change,
        ignored: Boolean(old?.ignored),
        // The page refreshes Git state after every scan; until then the last one stands.
        git: old?.git ?? null,
        previousSizeBytes: oldTotal ?? null,
        firstSeen: old?.firstSeen || now,
        lastSeen: now,
        missingSince: null
      };
    });

    const reclaimEvents = [];
    for (const project of currentProjects) {
      const old = byPath.get(project.path);
      const event = createReclaimEvent(old, project, now, `${Date.now()}-${reclaimEvents.length}`);
      if (event) reclaimEvents.push(event);
    }

    const retained = [];
    for (const project of previous.projects) {
      if (seen.has(project.path) || isExcludedProject(project.path, root)) continue;
      if (!isInside(project.path, root)) {
        retained.push(project);
        continue;
      }
      const present = await pathExists(project.path);
      const status = present ? 'unrecognized' : 'missing';
      const updated = {
        ...project,
        status,
        change: status,
        missingSince: present ? null : project.missingSince || now
      };
      retained.push(updated);
      const event = !present
        ? createReclaimEvent(project, { ...project, totalSizeBytes: 0 }, now, `${Date.now()}-${reclaimEvents.length}`)
        : null;
      if (event) reclaimEvents.push(event);
    }

    const lastScanReclaimedBytes = reclaimEvents.reduce((sum, event) => sum + event.bytes, 0);

    const store = {
      version: STORE_VERSION,
      scanRoot: root,
      lastScanAt: now,
      scanDurationMs: Date.now() - startedAt,
      inspectedDirectories,
      reclaimedTotalBytes: (previous.reclaimedTotalBytes || 0) + lastScanReclaimedBytes,
      lastScanReclaimedBytes,
      reclaimHistory: [...reclaimEvents.reverse(), ...(previous.reclaimHistory || [])].slice(0, 200),
      projects: [...currentProjects, ...retained].sort((a, b) => a.name.localeCompare(b.name))
    };
    await writeStore(store);
    return store;
  });
}

async function loadProjects() {
  return withStore(async () => {
    const store = await refreshPresence(await readStore());
    await writeStore(store);
    return store;
  });
}

async function setIgnored(projectPaths, ignored) {
  const requested = new Set(Array.isArray(projectPaths) ? projectPaths : []);
  if (!requested.size) throw new Error('Select at least one project.');
  return withStore(async () => {
    const store = await readStore();
    let updated = 0;
    store.projects = store.projects.map((project) => {
      if (!requested.has(project.path)) return project;
      updated += 1;
      return { ...project, ignored: Boolean(ignored) };
    });
    if (!updated) throw new Error('No matching projects were found.');
    await writeStore(store);
    return store;
  });
}

module.exports = {
  BUCKET_KEYS,
  SIZE_KEYS,
  pathExists,
  classifyMarkers,
  createReclaimEvent,
  detectProjects,
  directoryBreakdown,
  refreshPresence,
  loadProjects,
  scan,
  setIgnored
};
