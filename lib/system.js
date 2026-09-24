const fs = require('node:fs/promises');
const os = require('node:os');

// What the page needs to know about the machine it manages. Slop Finder is built
// and tested on macOS; other systems still run, but the page says so plainly
// instead of showing macOS names (Finder, ~/Library) that do not apply there.
const PLATFORMS = {
  darwin: { name: 'macOS', fileManager: 'Finder', supported: true },
  linux: { name: 'Linux', fileManager: 'file manager', supported: false },
  win32: { name: 'Windows', fileManager: 'File Explorer', supported: false }
};

// SystemVersion.plist is what `sw_vers` reads; reading it directly avoids a process.
async function macVersion() {
  try {
    const plist = await fs.readFile('/System/Library/CoreServices/SystemVersion.plist', 'utf8');
    const value = (key) => new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(plist)?.[1] || null;
    return { version: value('ProductVersion'), build: value('ProductBuildVersion') };
  } catch {
    return { version: null, build: null };
  }
}

let infoPromise;
function systemInfo() {
  infoPromise ||= (async () => {
    const platform = process.platform;
    const known = PLATFORMS[platform] || { name: platform, fileManager: 'file manager', supported: false };
    const { version, build } = platform === 'darwin' ? await macVersion() : { version: os.release(), build: null };
    return {
      platform,
      name: known.name,
      version,
      build,
      arch: process.arch,
      fileManager: known.fileManager,
      supported: known.supported
    };
  })();
  return infoPromise;
}

module.exports = { systemInfo };
