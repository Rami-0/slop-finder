const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createReclaimEvent, detectProjects, directoryBreakdown } = require('../server');
const rules = require('../lib/rules');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-index-'));
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'node_modules', 'dependency'), { recursive: true });
  await fs.mkdir(path.join(root, 'dist'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"fixture"}');
  await fs.writeFile(path.join(root, 'src', 'index.js'), 'console.log("source")');
  await fs.writeFile(path.join(root, 'node_modules', 'dependency', 'package.json'), '{"name":"not-a-project"}');
  await fs.writeFile(path.join(root, 'dist', 'bundle.js'), 'built output');
  return root;
}

async function write(file, content = 'x') {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
}

test('detects the project root and skips dependency manifests', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { found } = await detectProjects(root);
  assert.equal(found.length, 1);
  assert.equal(found[0].path, root);
  assert.equal(found[0].kind, 'JavaScript');
  assert.equal(found[0].category, 'code');
});

test('measures the complete folder and separates reclaimable data', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sizes = await directoryBreakdown(root);
  assert.ok(sizes.totalSizeBytes > 0);
  assert.ok(sizes.sourceSizeBytes > 0);
  assert.ok(sizes.dependencySizeBytes > 0);
  assert.ok(sizes.generatedSizeBytes > 0);
  assert.equal(
    sizes.reclaimableSizeBytes,
    sizes.dependencySizeBytes + sizes.generatedSizeBytes + sizes.cacheSizeBytes
  );
  assert.equal(
    sizes.totalSizeBytes,
    sizes.sourceSizeBytes + sizes.dependencySizeBytes + sizes.generatedSizeBytes + sizes.cacheSizeBytes + sizes.vcsSizeBytes
  );
});

test('records each rebuildable folder with how to restore it', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-index-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await write(path.join(root, 'package.json'), '{"workspaces":["apps/*"]}');
  await write(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
  await write(path.join(root, 'node_modules', '.pnpm', 'react', 'index.js'));
  await write(path.join(root, 'apps', 'web', 'package.json'), '{}');
  await write(path.join(root, 'apps', 'web', 'node_modules', 'next', 'index.js'));
  await write(path.join(root, 'apps', 'web', '.next', 'cache', 'x.pack'));
  await write(path.join(root, 'apps', 'web', 'node_modules', '.cache', 'inner.js'));
  await write(path.join(root, 'tools', '__pycache__', 'mod.pyc'));
  await write(path.join(root, 'build'), 'a file named build is source, not output');
  await write(path.join(root, 'lib', 'deps', 'kept.ex'));

  const { artifacts, lastActiveAt } = await directoryBreakdown(root);
  const byPath = new Map(artifacts.map((artifact) => [artifact.relativePath, artifact]));

  assert.deepEqual([...byPath.keys()].sort(), [
    'apps/web/.next', 'apps/web/node_modules', 'node_modules', 'tools/__pycache__'
  ].map((relative) => relative.split('/').join(path.sep)));
  assert.equal(byPath.get('node_modules').bucket, 'dependency');
  // Workspace packages inherit the lockfile from the monorepo root.
  assert.equal(byPath.get(path.join('apps', 'web', 'node_modules')).restore.command, 'pnpm install');
  assert.equal(byPath.get(path.join('apps', 'web', '.next')).bucket, 'generated');
  assert.equal(byPath.get(path.join('tools', '__pycache__')).bucket, 'cache');
  assert.ok(byPath.get('node_modules').sizeBytes > 0);
  assert.ok(lastActiveAt, 'source files provide a last-active time');
});

test('applies context-dependent artifact rules only next to their manifest', () => {
  assert.equal(rules.matchArtifactRule('deps', new Set(['mix.exs', 'deps']))?.label, 'Mix dependencies');
  assert.equal(rules.matchArtifactRule('deps', new Set(['package.json', 'deps'])), null);
  assert.equal(rules.matchArtifactRule('bin', new Set(['App.csproj']))?.bucket, 'generated');
  assert.equal(rules.matchArtifactRule('bin', new Set(['Cargo.toml'])), null);
  assert.equal(rules.matchArtifactRule('Library', new Set(['Assets', 'ProjectSettings']))?.label, 'Unity import cache');
});

test('skips firmlinked and system trees unless they were the scan root', () => {
  if (process.platform !== 'darwin') return;
  assert.equal(rules.isSystemPath('/System/Volumes/Data/Users/me/app', '/'), true);
  assert.equal(rules.isSystemPath('/opt/homebrew/Cellar/git', '/'), true);
  assert.equal(rules.isSystemPath('/Users/me/app', '/'), false);
  assert.equal(rules.isSystemPath('/private/tmp/checkout', '/'), false);
  assert.equal(rules.isSystemPath('/opt/homebrew/Library/Taps/x', '/opt/homebrew'), false);
  assert.ok(rules.DISCOVERY_SKIP_PATH_SET.has('/System'));
});

test('records reclaimed space without double-counting nested projects', () => {
  const previous = { path: '/projects/app', name: 'app', status: 'present', totalSizeBytes: 20_000 };
  const event = createReclaimEvent(previous, { ...previous, totalSizeBytes: 10_000, contained: false }, '2026-09-11T00:00:00.000Z', 'event-1');
  assert.equal(event.bytes, 10_000);
  assert.equal(event.reason, 'size-reduced');
  assert.equal(createReclaimEvent(previous, { ...previous, totalSizeBytes: 10_000, contained: true }, '2026-09-11T00:00:00.000Z', 'event-2'), null);
});
