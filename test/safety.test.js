const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { APP_DIR, HOME, PORT } = require('../lib/config');
const safety = require('../lib/safety');
const { requestRejection } = require('../server');

const HOME_ROOTS = [HOME];

test('protects system, credential, app, and metadata locations', () => {
  const reason = (target) => safety.protectionReason(target, HOME_ROOTS);
  assert.match(reason('/'), /top of the disk/);
  assert.match(reason(HOME), /home folder/);
  assert.match(reason(path.dirname(HOME)), /home folder/);
  assert.match(reason(path.join(HOME, 'Library', 'Caches', 'x')), /Library/);
  assert.match(reason(path.join(HOME, '.ssh')), /\.ssh/);
  assert.match(reason(path.join(HOME, 'Desktop')), /Standard home folders/);
  assert.match(reason(path.join(HOME, 'code', 'app', '.git')), /Version-control/);
  assert.match(reason(path.join(HOME, 'code', 'app', '.git', 'objects')), /Version-control/);
  assert.match(reason(path.join(APP_DIR, 'data')), /Slop Finder/);
  assert.match(reason(path.dirname(APP_DIR)), /contains Slop Finder/);
  if (process.platform === 'darwin') {
    assert.match(reason('/usr/local/lib'), /System/);
    assert.match(reason('/opt/homebrew/Cellar'), /System/);
    // APFS is case-insensitive, so casing tricks must not get past a protection.
    assert.match(reason(path.join(HOME, 'library', 'x')), /Library/);
    assert.match(reason(path.join(HOME, 'code', 'app', '.GIT')), /Version-control/);
  }
});

test('allows ordinary folders inside allowed locations only', () => {
  assert.equal(safety.protectionReason(path.join(HOME, 'Desktop', 'old-app', 'node_modules'), HOME_ROOTS), null);
  assert.equal(safety.protectionReason(path.join(HOME, 'Desktop', 'old-app'), HOME_ROOTS), null);
  assert.match(safety.protectionReason('/Volumes/Archive/app', HOME_ROOTS), /Outside the allowed locations/);
  assert.equal(safety.protectionReason('/Volumes/Archive/app', [...HOME_ROOTS, '/Volumes/Archive']), null);
  assert.match(safety.protectionReason('/Volumes/Archive', [...HOME_ROOTS, '/Volumes/Archive']), /Allowed locations are protected/);
});

test('rejects extra locations that would widen access to system or home roots', () => {
  assert.match(safety.rootRejection('/'), /whole disk/);
  assert.match(safety.rootRejection(HOME), /already allowed/);
  assert.match(safety.rootRejection(path.dirname(HOME)), /contains your home/);
  assert.match(safety.rootRejection(path.join(HOME, 'Desktop')), /already allowed/);
  if (process.platform === 'darwin') {
    assert.match(safety.rootRejection('/usr'), /System/);
    assert.match(safety.rootRejection('/opt'), /System/);
    assert.match(safety.rootRejection('/Volumes'), /specific drive/);
    assert.equal(safety.rootRejection('/Volumes/Archive'), null);
  }
});

test('resolves symlinked parents before deciding, and removes links rather than targets', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'slop-safety-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'project', 'node_modules'), { recursive: true });
  await fs.symlink(HOME, path.join(root, 'home-link'));

  const allowed = await safety.checkDeletable(path.join(root, 'project', 'node_modules'), { roots: [root] });
  assert.equal(allowed.ok, true);

  // Through the link, "home-link/Library" is really ~/Library.
  const escaped = await safety.checkDeletable(path.join(root, 'home-link', 'Library'), { roots: [root] });
  assert.equal(escaped.ok, false);
  assert.match(escaped.reason, /Library/);

  // The link entry itself is deletable: removing it never touches the target.
  const link = await safety.checkDeletable(path.join(root, 'home-link'), { roots: [root] });
  assert.equal(link.ok, true);
  assert.equal(link.real, path.join(root, 'home-link'));

  const trailing = await safety.checkDeletable(`${path.join(root, 'home-link')}/`, { roots: [root] });
  assert.equal(trailing.ok, false, 'a trailing slash would follow the link');
});

test('rejects requests that did not come from the app page', () => {
  const host = `127.0.0.1:${PORT}`;
  const request = (headers, method = 'POST') => ({ method, headers: { host, ...headers } });
  const good = { origin: `http://${host}`, 'x-slop-finder': '1', 'content-type': 'application/json' };

  assert.equal(requestRejection(request(good), true), null);
  assert.equal(requestRejection(request({ ...good, host: `localhost:${PORT}`, origin: `http://localhost:${PORT}` }), true), null);
  assert.equal(requestRejection(request({ ...good, host: 'evil.example:4173' }), true)[0], 421, 'DNS rebinding');
  assert.equal(requestRejection(request({ ...good, origin: 'https://evil.example' }), true)[0], 403, 'cross-site');
  assert.equal(requestRejection(request({ ...good, 'x-slop-finder': undefined }), true)[0], 403, 'simple request');
  assert.equal(requestRejection(request({ ...good, 'content-type': 'text/plain' }), true)[0], 415);
  assert.equal(requestRejection(request({}, 'GET'), false), null, 'static files only need the right host');
});
