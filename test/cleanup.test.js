const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Point the inventory at a throwaway folder before any module reads the config,
// so these tests never touch the real data/projects.json.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slop-data-'));
process.env.SLOP_FINDER_DATA_DIR = dataDir;

const { writeStore, readStore } = require('../lib/store');
const { directoryBreakdown } = require('../lib/scanner');
const { applyDeletion, collapseNested, createPlan, executeItem } = require('../lib/cleanup');

test.after(() => fsp.rm(dataDir, { recursive: true, force: true }));

async function write(file, content = 'x'.repeat(5000)) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content);
}

function git(cwd, ...args) {
  execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], { cwd, stdio: 'ignore' });
}

// A small repository: ignored node_modules and dist, plus a committed vendor/.
async function repositoryFixture() {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'slop-cleanup-')));
  await write(path.join(root, 'package.json'), '{"name":"fixture"}');
  await write(path.join(root, 'package-lock.json'), '{}');
  await write(path.join(root, '.gitignore'), 'node_modules/\ndist/\n');
  await write(path.join(root, 'src', 'index.js'));
  await write(path.join(root, 'vendor', 'library.js'));
  await write(path.join(root, 'node_modules', 'left-pad', 'index.js'));
  await write(path.join(root, 'dist', 'bundle.js'));
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  git(root, 'remote', 'add', 'origin', 'https://example.com/fixture.git');

  const breakdown = await directoryBreakdown(root);
  await writeStore({
    version: 5,
    scanRoot: path.dirname(root),
    reclaimedTotalBytes: 0,
    reclaimHistory: [],
    projects: [{
      path: root,
      name: path.basename(root),
      kind: 'JavaScript',
      category: 'code',
      status: 'present',
      contained: false,
      ...breakdown,
      sizeBytes: breakdown.totalSizeBytes
    }]
  });
  return { root, breakdown };
}

test('previews items with Git-aware risk before anything is deleted', async (t) => {
  const { root } = await repositoryFixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const plan = await createPlan([
    path.join(root, 'node_modules'),
    path.join(root, 'vendor'),
    path.join(root, '.git'),
    path.join(root, 'node_modules', 'left-pad')
  ]);
  const byName = new Map(plan.items.map((item) => [item.name, item]));

  const modules = byName.get('node_modules');
  assert.equal(modules.ok, true);
  assert.equal(modules.role, 'artifact');
  assert.equal(modules.git.state, 'ignored');
  assert.equal(modules.risk, 'low');
  assert.equal(modules.preselected, true);
  assert.equal(modules.restore.command, 'npm ci');
  assert.ok(!byName.has('left-pad'), 'items inside another selected item are folded into it');

  const vendor = byName.get('vendor');
  assert.equal(vendor.git.state, 'tracked');
  assert.equal(vendor.risk, 'high');
  assert.equal(vendor.preselected, false);

  const metadata = byName.get('.git');
  assert.equal(metadata.ok, false);
  assert.match(metadata.reason, /Version-control/);
  assert.equal(plan.defaultMode, 'permanent', 'every deletable item is rebuildable');
  assert.ok(!('identity' in modules), 'internal identity stays on the server');
});

test('flags a whole repository whose work exists only here', async (t) => {
  const { root } = await repositoryFixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  git(root, 'remote', 'remove', 'origin');
  await write(path.join(root, 'src', 'uncommitted.js'));
  const plan = await createPlan([root]);
  const [item] = plan.items;
  assert.equal(item.role, 'project');
  assert.equal(item.risk, 'high');
  assert.equal(item.preselected, false);
  assert.ok(item.notes.some((note) => /no remote/.test(note.text)));
  assert.ok(item.notes.some((note) => /uncommitted/.test(note.text)));
  assert.equal(plan.defaultMode, 'trash', 'non-rebuildable items default to the Trash');
});

test('deletes only reviewed items and keeps the inventory in step', async (t) => {
  const { root, breakdown } = await repositoryFixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'node_modules');
  const plan = await createPlan([target]);

  await assert.rejects(executeItem({ planId: 'not-a-plan', path: target, mode: 'permanent' }), /expired/);
  await assert.rejects(executeItem({ planId: plan.planId, path: path.join(root, 'dist'), mode: 'permanent' }), /not part of the review/);

  const result = await executeItem({ planId: plan.planId, path: target, mode: 'permanent' });
  assert.equal(result.ok, true);
  assert.ok(result.freedBytes > 0);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(path.join(root, 'src', 'index.js')), true, 'source is untouched');
  await assert.rejects(executeItem({ planId: plan.planId, path: target, mode: 'permanent' }), /already handled/);

  const store = await readStore();
  const [project] = store.projects;
  assert.equal(project.dependencySizeBytes, breakdown.dependencySizeBytes - result.freedBytes);
  assert.equal(project.totalSizeBytes, breakdown.totalSizeBytes - result.freedBytes);
  assert.ok(!project.artifacts.some((artifact) => artifact.path === target));
  assert.equal(store.reclaimHistory[0].reason, 'deleted');
  assert.equal(store.reclaimedTotalBytes, result.freedBytes);
});

test('two simultaneous requests for one item delete and count it once', async (t) => {
  const { root } = await repositoryFixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'dist');
  const plan = await createPlan([target]);
  const request = () => executeItem({ planId: plan.planId, path: target, mode: 'permanent' });

  const [first, second] = await Promise.allSettled([request(), request()]);
  const fulfilled = [first, second].filter((outcome) => outcome.status === 'fulfilled');
  const rejected = [first, second].filter((outcome) => outcome.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason.message, /already handled/);

  const store = await readStore();
  assert.equal(store.reclaimHistory.filter((event) => event.targetPath === target).length, 1);
  assert.equal(store.reclaimedTotalBytes, fulfilled[0].value.freedBytes);
});

test('refuses an item that was swapped after the review', async (t) => {
  const { root } = await repositoryFixture();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'dist');
  const plan = await createPlan([target]);
  await fsp.rm(target, { recursive: true });
  await write(path.join(target, 'different.js'));
  await assert.rejects(executeItem({ planId: plan.planId, path: target, mode: 'permanent' }), /changed after the review/);
  assert.equal(fs.existsSync(path.join(target, 'different.js')), true);
});

test('marks projects inside a removed folder as missing', () => {
  const store = {
    reclaimedTotalBytes: 0,
    reclaimHistory: [],
    projects: [
      { path: '/w/app', name: 'app', contained: false, status: 'present', totalSizeBytes: 100, sourceSizeBytes: 40, dependencySizeBytes: 60, generatedSizeBytes: 0, cacheSizeBytes: 0, vcsSizeBytes: 0, artifacts: [{ path: '/w/app/pkg/node_modules', sizeBytes: 60 }] },
      { path: '/w/app/pkg', name: 'pkg', contained: true, status: 'present', totalSizeBytes: 70 }
    ]
  };
  const freed = { totalSizeBytes: 70, sourceSizeBytes: 10, dependencySizeBytes: 60, generatedSizeBytes: 0, cacheSizeBytes: 0, vcsSizeBytes: 0 };
  const event = applyDeletion(store, { real: '/w/app/pkg', name: 'pkg', label: 'Folder' }, freed, { mode: 'trash', removed: true, now: 'now' });
  assert.equal(store.projects[0].totalSizeBytes, 30);
  assert.equal(store.projects[0].reclaimableSizeBytes, 0);
  assert.deepEqual(store.projects[0].artifacts, []);
  assert.equal(store.projects[1].status, 'missing');
  assert.equal(event.projectName, 'app');
  assert.equal(event.reason, 'trashed');
  assert.deepEqual(collapseNested(['/w/app/pkg/node_modules', '/w/app', '/w/other']), ['/w/app', '/w/other']);
});
