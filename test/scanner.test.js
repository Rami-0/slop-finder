const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { detectProjects, directoryBreakdown } = require('../server');

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
