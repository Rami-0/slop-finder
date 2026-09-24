const fs = require('node:fs/promises');
const os = require('node:os');
const { DATA_DIR, STORE_PATH } = require('./config');

const STORE_VERSION = 5;

function emptyStore() {
  return {
    version: STORE_VERSION,
    scanRoot: os.homedir(),
    lastScanAt: null,
    reclaimedTotalBytes: 0,
    lastScanReclaimedBytes: 0,
    reclaimHistory: [],
    projects: []
  };
}

async function readStore() {
  try {
    return JSON.parse(await fs.readFile(STORE_PATH, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read store:', error.message);
    return emptyStore();
  }
}

async function writeStore(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempPath = `${STORE_PATH}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify({ ...store, version: STORE_VERSION }, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, STORE_PATH);
}

// Scans, deletions, and presence refreshes all read-modify-write the same file.
// Running them one at a time keeps a slow scan from overwriting a deletion's
// bookkeeping (or the reverse).
let queue = Promise.resolve();
function withStore(task) {
  const run = queue.then(() => task());
  queue = run.catch(() => {});
  return run;
}

module.exports = { STORE_VERSION, emptyStore, readStore, writeStore, withStore };
