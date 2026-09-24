const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..');
// A separate data directory lets a second instance (tests, a sandbox scan) run
// without touching the real inventory.
const DATA_DIR = process.env.SLOP_FINDER_DATA_DIR
  ? path.resolve(process.env.SLOP_FINDER_DATA_DIR)
  : path.join(APP_DIR, 'data');

module.exports = {
  HOST: '127.0.0.1',
  PORT: Number(process.env.PORT || 4173),
  APP_DIR,
  PUBLIC_DIR: path.join(APP_DIR, 'public'),
  DATA_DIR,
  STORE_PATH: path.join(DATA_DIR, 'projects.json'),
  HOME: os.homedir()
};
