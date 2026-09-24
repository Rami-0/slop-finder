const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { mapLimit } = require('./limit');
const { isInsideFolded, samePath } = require('./paths');
const { SIZE_KEYS, directoryBreakdown } = require('./scanner');
const { readStore, writeStore, withStore } = require('./store');
const safety = require('./safety');
const { inspectTarget, invalidateMeasurements } = require('./inspect');

// A plan is the reviewed list of items. Deleting requires a plan id, so nothing
// can be removed that was not previewed first, and each item is re-checked for
// identity (same inode) right before it goes.
const PLAN_TTL_MS = 30 * 60 * 1000;
const MAX_PLAN_ITEMS = 1000;
const TRASH_BIN = '/usr/bin/trash';
const plans = new Map();

function prunePlans() {
  const cutoff = Date.now() - PLAN_TTL_MS;
  for (const [id, plan] of plans) if (plan.createdAt < cutoff) plans.delete(id);
}

// Selecting a folder and something inside it would delete the inner item twice.
function collapseNested(paths) {
  const kept = [];
  for (const candidate of [...new Set(paths)].sort((a, b) => a.length - b.length)) {
    if (!kept.some((parent) => isInsideFolded(candidate, parent))) kept.push(candidate);
  }
  return kept;
}

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${path.basename(command)} exited with code ${code}`));
    });
  });
}

async function trashAvailable() {
  if (process.platform === 'darwin') return true;
  if (process.platform !== 'linux') return false;
  try {
    await runCommand('gio', ['--version']);
    return true;
  } catch {
    return false;
  }
}

// The system Trash keeps "Put Back" working. /usr/bin/trash ships with macOS 15+;
// older systems fall back to asking Finder, with the path passed as an argument
// rather than spliced into the script.
async function moveToTrash(real) {
  if (process.platform === 'darwin') {
    if (await exists(TRASH_BIN)) return runCommand(TRASH_BIN, ['-s', real]);
    return runCommand('/usr/bin/osascript', [
      '-e', 'on run argv',
      '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)',
      '-e', 'end run',
      real
    ]);
  }
  if (process.platform === 'linux') return runCommand('gio', ['trash', '--', real]);
  throw new Error('Moving to the Trash is not available on this system.');
}

function describeFailure(error) {
  if (!error) return 'Some files could not be removed.';
  if (['EACCES', 'EPERM'].includes(error.code)) return `${process.platform === 'darwin' ? 'macOS' : 'The system'} denied permission for some files.`;
  if (['EBUSY', 'ENOTEMPTY'].includes(error.code)) return 'Some files were in use. Close the apps using them and try again.';
  return error.message;
}

function publicItem(item) {
  const { identity, status, ...rest } = item;
  return rest;
}

async function createPlan(paths, { extraRoots } = {}) {
  prunePlans();
  const requested = Array.isArray(paths) ? paths.filter((target) => typeof target === 'string') : [];
  if (!requested.length) throw new Error('Choose at least one item to review.');
  if (requested.length > MAX_PLAN_ITEMS) throw new Error(`Review at most ${MAX_PLAN_ITEMS} items at a time.`);

  const [store, roots] = await Promise.all([readStore(), safety.allowedRoots(extraRoots)]);
  const items = await mapLimit(collapseNested(requested), 3, (target) => inspectTarget(target, { roots, store }));
  const plan = { id: crypto.randomUUID(), createdAt: Date.now(), roots, items: new Map() };
  for (const item of items) if (item.ok) plan.items.set(item.path, { ...item, status: 'pending' });
  plans.set(plan.id, plan);

  const ready = items.filter((item) => item.ok);
  items.sort((a, b) => Number(b.ok) - Number(a.ok) || (b.sizeBytes || 0) - (a.sizeBytes || 0));
  return {
    planId: plan.id,
    expiresAt: new Date(plan.createdAt + PLAN_TTL_MS).toISOString(),
    // Rebuildable output defaults to permanent deletion (it frees space now and
    // tools recreate it); anything else defaults to the Trash.
    defaultMode: ready.length && ready.every((item) => item.rebuildable) ? 'permanent' : 'trash',
    trashAvailable: await trashAvailable(),
    items: items.map(publicItem)
  };
}

// What is still on disk after an attempt, so partial failures are reported
// honestly instead of claiming the full size was freed.
async function remainingBreakdown(item) {
  if (!(await exists(item.real))) return null;
  if (item.type === 'dir') return directoryBreakdown(item.real, { rootBucket: item.bucket });
  return { ...item.breakdown };
}

// Keeps the inventory in step with the disk: containing projects shrink, projects
// inside a removed folder become missing, and the space joins reclaimed history.
// Updating here (instead of waiting for the next scan) also stops that scan from
// counting the same bytes a second time.
function applyDeletion(store, item, freed, { mode, removed, now }) {
  for (const project of store.projects) {
    if (removed && isInsideFolded(project.path, item.real)) {
      if (project.status !== 'missing') Object.assign(project, { status: 'missing', missingSince: now, change: 'removed' });
      continue;
    }
    if (!isInsideFolded(item.real, project.path)) continue;
    for (const key of SIZE_KEYS) project[key] = Math.max(0, (project[key] ?? 0) - freed[key]);
    project.sizeBytes = project.totalSizeBytes;
    project.reclaimableSizeBytes = project.dependencySizeBytes + project.generatedSizeBytes + project.cacheSizeBytes;
    if (Array.isArray(project.artifacts)) {
      project.artifacts = project.artifacts.flatMap((artifact) => {
        if (removed && isInsideFolded(artifact.path, item.real)) return [];
        if (isInsideFolded(item.real, artifact.path)) {
          return [{ ...artifact, sizeBytes: Math.max(0, artifact.sizeBytes - freed.totalSizeBytes) }];
        }
        return [artifact];
      });
    }
    project.change = 'cleaned';
  }

  const owner = store.projects
    .filter((project) => !project.contained && isInsideFolded(item.real, project.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const event = {
    id: `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
    at: now,
    projectPath: owner?.path || item.real,
    projectName: owner?.name || item.name,
    targetPath: item.real,
    label: item.label,
    bytes: freed.totalSizeBytes,
    reason: mode === 'trash' ? 'trashed' : 'deleted',
    beforeBytes: null,
    afterBytes: null
  };
  store.reclaimedTotalBytes = (store.reclaimedTotalBytes || 0) + event.bytes;
  store.reclaimHistory = [event, ...(store.reclaimHistory || [])].slice(0, 200);
  return event;
}

async function executeItem({ planId, path: target, mode } = {}) {
  const plan = plans.get(planId);
  if (!plan || Date.now() - plan.createdAt > PLAN_TTL_MS) {
    throw new Error('This review expired. Open it again to see the current state.');
  }
  const item = plan.items.get(target);
  if (!item) throw new Error('This item was not part of the review.');
  if (mode !== 'trash' && mode !== 'permanent') throw new Error('Choose Move to Trash or Delete permanently.');
  if (item.status !== 'pending') throw new Error('This item was already handled.');
  // Claim the item before the first await, so a second request for the same item
  // (a retried or duplicated call) is refused instead of deleting and counting twice.
  item.status = 'running';

  const check = await safety.checkDeletable(target, { roots: plan.roots });
  if (!check.ok) {
    item.status = 'pending';
    throw new Error(check.reason);
  }
  if (!samePath(check.real, item.real) || check.stats.ino !== item.identity.ino || check.stats.dev !== item.identity.dev) {
    item.status = 'stale';
    throw new Error('This item changed after the review. Review it again.');
  }

  const startedAt = Date.now();
  let failure = null;
  try {
    if (mode === 'trash') await moveToTrash(item.real);
    else await fs.rm(item.real, { recursive: true, force: false, maxRetries: 2, retryDelay: 150 });
  } catch (error) {
    failure = error;
  }

  const remaining = await remainingBreakdown(item);
  const freed = Object.fromEntries(SIZE_KEYS.map((key) => [key, Math.max(0, (item.breakdown[key] || 0) - (remaining?.[key] || 0))]));
  item.status = remaining ? 'failed' : 'done';
  invalidateMeasurements(item.real);
  if (remaining && !freed.totalSizeBytes) throw new Error(describeFailure(failure));

  const store = await withStore(async () => {
    const current = await readStore();
    applyDeletion(current, item, freed, { mode, removed: !remaining, now: new Date().toISOString() });
    await writeStore(current);
    return current;
  });
  return {
    path: target,
    ok: !remaining,
    mode,
    freedBytes: freed.totalSizeBytes,
    durationMs: Date.now() - startedAt,
    error: remaining ? `Partly deleted. ${describeFailure(failure)}` : null,
    store
  };
}

module.exports = { applyDeletion, collapseNested, createPlan, executeItem, moveToTrash };
