const fs = require('node:fs/promises');
const path = require('node:path');
const { HOME } = require('./config');
const { fold, formatBytes, isInside, isInsideFolded, samePath } = require('./paths');
const rules = require('./rules');
const { BUCKET_KEYS, SIZE_KEYS, directoryBreakdown } = require('./scanner');
const { readStore } = require('./store');
const safety = require('./safety');
const git = require('./git');

const BROWSE_LIMIT = 2000;
const MEASURE_TTL_MS = 10 * 60 * 1000;
const MAX_REPOSITORY_SUMMARIES = 6;
const RISK_LEVELS = ['low', 'medium', 'high'];

const measureCache = new Map();

function diskBytes(stats) {
  return Number.isFinite(stats.blocks) ? stats.blocks * 512 : stats.size;
}

function tildify(target) {
  return isInside(target, HOME) ? `~${target.slice(HOME.length)}` : target;
}

function plural(count, noun, pluralNoun = `${noun}s`) {
  return `${count.toLocaleString('en-US')} ${count === 1 ? noun : pluralNoun}`;
}

async function readNames(directory) {
  try {
    return new Set(await fs.readdir(directory));
  } catch {
    return new Set();
  }
}

// The deepest indexed project around `real`, and the rebuildable folder of that
// project that contains it (browsing inside node_modules, for example).
function projectContext(store, real) {
  const containing = store.projects
    .filter((project) => project.status !== 'missing' && isInsideFolded(real, project.path))
    .sort((a, b) => b.path.length - a.path.length);
  let artifact = null;
  for (const project of containing) {
    artifact = (project.artifacts || []).find((item) => isInsideFolded(real, item.path)) || null;
    if (artifact) break;
  }
  return { project: containing[0] || null, artifact };
}

function cachedMeasure(real) {
  const entry = measureCache.get(fold(real));
  if (!entry) return null;
  if (Date.now() - entry.at > MEASURE_TTL_MS) {
    measureCache.delete(fold(real));
    return null;
  }
  return entry.result;
}

// A deletion changes the size of the item, everything inside it, and every
// folder above it.
function invalidateMeasurements(real) {
  const target = fold(real);
  for (const key of measureCache.keys()) {
    if (isInside(key, target) || isInside(target, key)) measureCache.delete(key);
  }
}

async function browse(target, { extraRoots } = {}) {
  if (!safety.isNormalizedAbsolute(target)) throw new Error('Choose an absolute folder path.');
  let real;
  try {
    real = await fs.realpath(target);
  } catch {
    throw new Error('That folder no longer exists.');
  }
  if (!(await fs.stat(real)).isDirectory()) throw new Error('That path is a file, not a folder.');
  let dirents;
  try {
    dirents = await fs.readdir(target, { withFileTypes: true });
  } catch (error) {
    const denied = process.platform === 'darwin'
      ? 'macOS denied access to this folder. Grant your terminal Full Disk Access to browse it.'
      : 'The system denied access to this folder.';
    throw new Error(['EACCES', 'EPERM'].includes(error.code) ? denied : 'Could not read this folder.');
  }

  const [store, roots] = await Promise.all([readStore(), safety.allowedRoots(extraRoots)]);
  const names = new Set(dirents.map((dirent) => dirent.name));
  const projectsByPath = new Map(store.projects.map((project) => [fold(project.path), project]));
  const context = projectContext(store, real);

  const entries = await Promise.all(dirents.slice(0, BROWSE_LIMIT).map(async (dirent) => {
    const entryPath = path.join(target, dirent.name);
    const entryReal = path.join(real, dirent.name);
    const type = dirent.isDirectory() ? 'dir' : dirent.isFile() ? 'file' : dirent.isSymbolicLink() ? 'symlink' : 'other';
    let stats = null;
    try {
      stats = await fs.lstat(entryPath);
    } catch {}
    const rule = type === 'dir' && !context.artifact ? rules.matchArtifactRule(dirent.name, names) : null;
    const project = projectsByPath.get(fold(entryReal));
    const measured = type === 'dir' ? cachedMeasure(entryReal) : null;
    let linkTarget = null;
    if (type === 'symlink') {
      try {
        linkTarget = await fs.readlink(entryPath);
      } catch {}
    }
    let repository = false;
    if (type === 'dir' && dirent.name !== '.git') {
      try {
        await fs.access(path.join(entryPath, '.git'));
        repository = true;
      } catch {}
    }
    return {
      name: dirent.name,
      path: entryPath,
      type,
      sizeBytes: type === 'dir' ? measured?.totalSizeBytes ?? null : stats ? diskBytes(stats) : 0,
      fileCount: type === 'dir' ? measured?.fileCount ?? null : null,
      modifiedAt: stats ? stats.mtime.toISOString() : null,
      artifact: rule ? { bucket: rule.bucket, label: rule.label, ambiguous: Boolean(rule.ambiguous) } : null,
      project: project ? { name: project.name, kind: project.kind, category: project.category } : null,
      repository,
      linkTarget,
      lock: safety.protectionReason(entryReal, roots)
    };
  }));

  return {
    path: target,
    real,
    parent: target === path.parse(target).root ? null : path.dirname(target),
    lock: safety.protectionReason(real, roots),
    project: context.project
      ? { path: context.project.path, name: context.project.name, kind: context.project.kind }
      : null,
    insideArtifact: context.artifact
      ? { path: context.artifact.path, label: context.artifact.label, bucket: context.artifact.bucket }
      : null,
    entries,
    total: dirents.length,
    truncated: dirents.length > BROWSE_LIMIT
  };
}

async function measure(target, { fresh = false, signal } = {}) {
  if (!safety.isNormalizedAbsolute(target)) throw new Error('Choose an absolute folder path.');
  let real;
  try {
    real = await fs.realpath(target);
  } catch {
    throw new Error('That folder no longer exists.');
  }
  if (!fresh) {
    const cached = cachedMeasure(real);
    if (cached) return { path: target, ...cached, cached: true };
  }
  const store = await readStore();
  const { artifact } = projectContext(store, real);
  const rule = artifact ? null : rules.matchArtifactRule(path.basename(real), await readNames(path.dirname(real)));
  const rootBucket = artifact?.bucket || rule?.bucket || 'source';
  const breakdown = await directoryBreakdown(real, { rootBucket, signal });
  const result = {
    totalSizeBytes: breakdown.totalSizeBytes,
    reclaimableSizeBytes: breakdown.reclaimableSizeBytes,
    fileCount: breakdown.fileCount,
    dirCount: breakdown.dirCount,
    linkedBytes: breakdown.linkedBytes
  };
  if (!breakdown.aborted) measureCache.set(fold(real), { at: Date.now(), result });
  return { path: target, ...result, aborted: breakdown.aborted };
}

// Walks up from `real` to `stopAt` collecting inherited facts (the workspace
// lockfile), the same way a scan would have seen them.
async function ancestorContext(real, stopAt) {
  const chain = [];
  if (stopAt) {
    for (let directory = path.dirname(path.dirname(real)); isInsideFolded(directory, stopAt); directory = path.dirname(directory)) {
      chain.unshift(directory);
      if (samePath(directory, stopAt) || directory === path.dirname(directory)) break;
    }
  }
  let context = {};
  for (const directory of chain) context = rules.inheritContext(context, await readNames(directory));
  return context;
}

async function sampleContents(real, limit = 14) {
  let dirents;
  try {
    dirents = await fs.readdir(real, { withFileTypes: true });
  } catch {
    return null;
  }
  dirents.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  return {
    total: dirents.length,
    entries: dirents.slice(0, limit).map((dirent) => ({
      name: dirent.name,
      type: dirent.isDirectory() ? 'dir' : dirent.isFile() ? 'file' : dirent.isSymbolicLink() ? 'symlink' : 'other'
    }))
  };
}

// Turns what we know about an item into a risk level and plain-language notes.
// Rebuildable output starts low; anything else starts medium; anything whose loss
// could not be undone from another copy (tracked source, unpushed commits,
// uncommitted work) is high and is never pre-selected.
function assess({ real, role, rule, gitStatus, repositories, repositoryCount, breakdown, restore }) {
  const notes = [];
  let risk = role === 'artifact' || role === 'inside-artifact' ? 'low' : 'medium';
  const raise = (level) => {
    if (RISK_LEVELS.indexOf(level) > RISK_LEVELS.indexOf(risk)) risk = level;
  };

  if (role === 'project' || role === 'folder') {
    notes.push({ level: 'warn', text: 'Not rebuildable output. Anything inside is gone unless another copy exists.' });
  } else if (role === 'file') {
    notes.push({ level: 'warn', text: 'A regular file, not rebuildable output.' });
  }
  if (rule?.ambiguous && gitStatus.state !== 'ignored') {
    raise('medium');
    notes.push({
      level: 'warn',
      text: `Folders named "${rule.name}" are usually generated, but some projects keep hand-written files there. Check the contents.`
    });
  }
  if (gitStatus.state === 'tracked') {
    raise('high');
    notes.push({
      level: 'danger',
      text: `${plural(gitStatus.trackedFiles, 'file')} tracked by Git in ${tildify(gitStatus.repo)}, so this is part of the project's source.`
    });
  } else if (gitStatus.state === 'ignored') {
    notes.push({ level: 'ok', text: 'Listed in .gitignore, so the project treats it as disposable.' });
  } else if (gitStatus.state === 'unknown') {
    raise('medium');
    notes.push({ level: 'warn', text: `Git could not tell whether this is part of ${tildify(gitStatus.repo)}.` });
  }

  for (const repository of repositories) {
    const where = samePath(repository.path, real) ? 'This repository' : `${tildify(repository.path)}`;
    if (!repository.readable) {
      raise('high');
      notes.push({ level: 'danger', text: `Could not read the Git status of ${where}.` });
      continue;
    }
    if (repository.remotes === 0) {
      raise('high');
      notes.push({ level: 'danger', text: `${where} has no remote, so its history (${plural(repository.localOnlyCommits, 'commit')}) exists only here.` });
    } else if (repository.localOnlyCommits) {
      raise('high');
      notes.push({ level: 'danger', text: `${where} has ${plural(repository.localOnlyCommits, 'commit')} that no remote has, as of the last fetch.` });
    }
    if (repository.origin?.local) {
      notes.push({ level: 'info', text: `${where} pushes to a folder on this computer (${repository.origin.url}). That is only a backup if the folder is on another drive.` });
    }
    if (repository.changes) {
      raise('high');
      notes.push({ level: 'danger', text: `${where} has ${plural(repository.changes, 'uncommitted change')}.` });
    }
    if (repository.stashes) {
      raise('high');
      notes.push({ level: 'danger', text: `${where} has ${plural(repository.stashes, 'stash', 'stashes')}.` });
    }
    if (repository.remotes && !repository.localOnlyCommits && !repository.changes && !repository.stashes && !repository.origin?.local) {
      const remote = repository.origin?.slug ? `${repository.origin.host}/${repository.origin.slug}` : repository.origin?.url || 'its remote';
      notes.push({ level: 'ok', text: `${where}: every commit is on ${remote} and nothing is uncommitted, as of the last fetch.` });
    }
  }
  if (repositoryCount > repositories.length) {
    raise('high');
    notes.push({
      level: 'danger',
      text: `Contains ${repositoryCount} Git repositories; only the first ${repositories.length} were checked.`
    });
  }
  if (restore?.note) notes.push({ level: 'info', text: restore.note });
  if (breakdown.linkedBytes > 1_000_000 && breakdown.linkedBytes > breakdown.totalSizeBytes * 0.2) {
    notes.push({
      level: 'info',
      text: `${formatBytes(breakdown.linkedBytes)} is hard-linked with files elsewhere (pnpm does this), so deleting frees less than the size shown.`
    });
  }
  return { risk, notes };
}

async function inspectTarget(target, { roots, store }) {
  const check = await safety.checkDeletable(target, { roots });
  if (!check.ok) return { path: target, ok: false, name: path.basename(target), reason: check.reason };
  const { real, stats } = check;
  const type = stats.isDirectory() ? 'dir' : stats.isSymbolicLink() ? 'symlink' : 'file';
  const parentNames = await readNames(path.dirname(real));
  const rule = type === 'dir' ? rules.matchArtifactRule(path.basename(real), parentNames) : null;
  const context = projectContext(store, real);
  const insideArtifact = !rule && context.artifact && !samePath(context.artifact.path, real) ? context.artifact : null;
  const bucket = rule?.bucket || insideArtifact?.bucket || 'source';
  const role = rule
    ? 'artifact'
    : insideArtifact
      ? 'inside-artifact'
      : context.project && samePath(context.project.path, real)
        ? 'project'
        : type === 'dir' ? 'folder' : 'file';

  let breakdown;
  if (type === 'dir') {
    breakdown = await directoryBreakdown(real, { rootBucket: bucket });
  } else {
    const bytes = diskBytes(stats);
    breakdown = {
      ...Object.fromEntries(SIZE_KEYS.map((key) => [key, 0])),
      totalSizeBytes: bytes,
      [BUCKET_KEYS[bucket]]: bytes,
      fileCount: type === 'file' ? 1 : 0,
      dirCount: 0,
      linkedBytes: stats.nlink > 1 ? bytes : 0,
      repositories: []
    };
  }

  let restore = null;
  if (rule) {
    const recorded = context.project && (context.project.artifacts || []).find((item) => samePath(item.path, real));
    restore = recorded?.restore || rules.restoreInfo(rule, parentNames, await ancestorContext(real, context.project?.path));
  }

  const [gitStatus, repositories, sample] = await Promise.all([
    git.pathStatus(real),
    Promise.all(breakdown.repositories.slice(0, MAX_REPOSITORY_SUMMARIES).map(git.repositorySummary)),
    type === 'dir' ? sampleContents(real) : null
  ]);
  const { risk, notes } = assess({
    real,
    role,
    rule,
    gitStatus,
    repositories,
    repositoryCount: breakdown.repositories.length,
    breakdown,
    restore
  });

  return {
    ok: true,
    path: target,
    real,
    name: path.basename(real),
    type,
    role,
    label: rule?.label ||
      (insideArtifact ? `Inside ${insideArtifact.label.toLowerCase()}` : null) ||
      (role === 'project' ? `${context.project.kind} project` : null) ||
      (type === 'dir' ? 'Folder' : type === 'symlink' ? 'Symbolic link (only the link is removed)' : 'File'),
    bucket,
    rebuildable: role === 'artifact' || role === 'inside-artifact',
    sizeBytes: breakdown.totalSizeBytes,
    fileCount: breakdown.fileCount,
    dirCount: breakdown.dirCount,
    linkedBytes: breakdown.linkedBytes,
    breakdown: Object.fromEntries(SIZE_KEYS.map((key) => [key, breakdown[key]])),
    git: gitStatus,
    repositories,
    restore,
    risk,
    notes,
    preselected: risk !== 'high',
    sample,
    project: context.project ? { path: context.project.path, name: context.project.name } : null,
    identity: { dev: stats.dev, ino: stats.ino }
  };
}

module.exports = { browse, measure, inspectTarget, invalidateMeasurements, projectContext };
