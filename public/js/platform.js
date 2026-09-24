// The machine the server runs on, as /api/system reports it. Until it arrives the
// page assumes macOS, the system Slop Finder is built and tested on.
let info = { platform: 'darwin', name: 'macOS', version: null, fileManager: 'Finder', supported: true };

export function setPlatform(value) {
  if (value?.platform) info = value;
}

export function platformInfo() {
  return info;
}

// "Finder" on macOS, "File Explorer" on Windows, "file manager" elsewhere.
export function fileManager() {
  return info.fileManager;
}
