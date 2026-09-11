const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 4173);
const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const DATA_DIR = path.join(APP_DIR, 'data');
const STORE_PATH = path.join(DATA_DIR, 'projects.json');

const PROJECT_MARKERS = new Map([
  ['package.json', ['JavaScript', 'code']], ['deno.json', ['Deno', 'code']], ['deno.jsonc', ['Deno', 'code']],
  ['bun.lockb', ['JavaScript', 'code']], ['Cargo.toml', ['Rust', 'code']], ['go.mod', ['Go', 'code']],
  ['pyproject.toml', ['Python', 'code']], ['setup.py', ['Python', 'code']], ['setup.cfg', ['Python', 'code']],
  ['requirements.txt', ['Python', 'code']], ['Pipfile', ['Python', 'code']], ['uv.lock', ['Python', 'code']],
  ['manage.py', ['Python / Django', 'code']], ['poetry.lock', ['Python', 'code']],
  ['Gemfile', ['Ruby', 'code']], ['composer.json', ['PHP', 'code']], ['pom.xml', ['Java', 'code']],
  ['build.gradle', ['Java', 'code']], ['build.gradle.kts', ['Kotlin', 'code']], ['settings.gradle', ['Java', 'code']],
  ['Package.swift', ['Swift', 'code']], ['Podfile', ['Apple', 'code']], ['mix.exs', ['Elixir', 'code']],
  ['pubspec.yaml', ['Dart / Flutter', 'code']], ['project.godot', ['Godot', 'code']], ['build.zig', ['Zig', 'code']],
  ['platformio.ini', ['PlatformIO', 'code']], ['global.json', ['Dotnet', 'code']],
  ['CMakeLists.txt', ['C / C++', 'code']], ['meson.build', ['C / C++', 'code']], ['Makefile', ['Make', 'code']],
  ['DESCRIPTION', ['R', 'code']], ['Project.toml', ['Julia', 'code']], ['rebar.config', ['Erlang', 'code']],
  ['dune-project', ['OCaml', 'code']], ['stack.yaml', ['Haskell', 'code']], ['cabal.project', ['Haskell', 'code']],
  ['flake.nix', ['Nix', 'infrastructure']], ['WORKSPACE', ['Bazel', 'code']], ['WORKSPACE.bazel', ['Bazel', 'code']],
  ['MODULE.bazel', ['Bazel', 'code']], ['Dockerfile', ['Docker', 'infrastructure']],
  ['docker-compose.yml', ['Docker', 'infrastructure']], ['docker-compose.yaml', ['Docker', 'infrastructure']],
  ['compose.yml', ['Docker', 'infrastructure']], ['compose.yaml', ['Docker', 'infrastructure']],
  ['Pulumi.yaml', ['Pulumi', 'infrastructure']], ['Chart.yaml', ['Helm', 'infrastructure']],
  ['serverless.yml', ['Serverless', 'infrastructure']], ['serverless.yaml', ['Serverless', 'infrastructure']],
  ['ansible.cfg', ['Ansible', 'infrastructure']], ['foundry.toml', ['Solidity', 'code']],
  ['hardhat.config.js', ['Solidity', 'code']], ['hardhat.config.ts', ['Solidity', 'code']],
  ['mkdocs.yml', ['Documentation', 'documentation']], ['book.toml', ['Documentation', 'documentation']],
  ['_config.yml', ['Static site', 'documentation']], ['.git', ['Git', 'repository']],
  ['.hg', ['Mercurial', 'repository']], ['.svn', ['Subversion', 'repository']], ['.git-bare', ['Bare Git', 'repository']],
  ['Unity project', ['Unity', 'code']]
]);

const WILDCARD_MARKERS = [
  [/\.sln$/i, 'Dotnet', 'code'], [/\.(cs|fs|vb)proj$/i, 'Dotnet', 'code'],
  [/\.xcodeproj$/i, 'Xcode', 'code'], [/\.xcworkspace$/i, 'Xcode', 'code'],
  [/\.uproject$/i, 'Unreal', 'code'], [/\.rockspec$/i, 'Lua', 'code'], [/\.ino$/i, 'Arduino', 'code'],
  [/\.ipynb$/i, 'Notebook', 'data'], [/\.tf$/i, 'Terraform', 'infrastructure']
];

const SOURCE_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.py', '.rs', '.go', '.rb', '.php', '.java', '.kt', '.kts', '.swift',
  '.c', '.h', '.cc', '.cpp', '.cxx', '.cs', '.fs', '.vb', '.ex', '.exs', '.erl', '.hrl', '.dart',
  '.lua', '.zig', '.sol', '.r', '.jl', '.hs', '.ml', '.scala', '.clj', '.vue', '.svelte', '.ino', '.sh', '.ps1'
]);

const DISCOVERY_SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', '.next', '.nuxt', '.cache', '.turbo',
  'dist', 'build', 'target', 'vendor', '.venv', 'venv', '__pycache__', 'cdk.out',
  'coverage', '.coverage', '.gradle', 'Pods', 'DerivedData', 'out',
  'Library', 'Applications', 'Movies', 'Music', 'Pictures', '.Trash'
]);

const DEPENDENCY_DIRS = new Set(['node_modules', 'vendor', '.venv', 'venv', 'Pods', '.gradle', '.bundle']);
const GENERATED_DIRS = new Set(['dist', 'build', 'target', '.next', '.nuxt', '.turbo', 'cdk.out', 'out', 'coverage']);
const CACHE_DIRS = new Set(['.cache', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
};

async function readStore() {
  try {
    return JSON.parse(await fs.readFile(STORE_PATH, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read store:', error.message);
    return { version: 3, scanRoot: os.homedir(), lastScanAt: null, projects: [] };
  }
}

async function writeStore(store) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tempPath = `${STORE_PATH}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, STORE_PATH);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function markerDetails(marker) {
  if (PROJECT_MARKERS.has(marker)) {
    const [kind, category] = PROJECT_MARKERS.get(marker);
    return { kind, category };
  }
  const wildcard = WILDCARD_MARKERS.find(([pattern]) => pattern.test(marker));
  return wildcard ? { kind: wildcard[1], category: wildcard[2] } : null;
}

function hasRepositoryMarker(markers) {
  return markers.some((marker) => ['.git', '.git-bare', '.hg', '.svn'].includes(marker));
}

function classifyMarkers(markers, entries = []) {
  const meaningful = markers.filter((marker) => marker !== '.git');
  const details = meaningful.map(markerDetails).filter(Boolean);
  if (details.length) {
    const preferred = details.find((item) => item.category === 'code') || details[0];
    return preferred;
  }

  const names = entries.map((entry) => entry.name);
  const hasSource = names.some((name) => SOURCE_EXTENSIONS.has(path.extname(name).toLowerCase())) ||
    names.some((name) => ['src', 'app', 'lib', 'cmd'].includes(name));
  if (hasSource) return { kind: 'Source', category: 'code' };
  if (names.some((name) => /^(docs?|readme)/i.test(name))) return { kind: 'Docs', category: 'documentation' };
  if (names.some((name) => /^\.(zsh|bash|vim|config)|dotfiles/i.test(name))) return { kind: 'Config', category: 'config' };
  return { kind: 'Git', category: 'repository' };
}

async function refreshPresence(store) {
  store.projects = store.projects.filter((project) =>
    !project.path.split(path.sep).some((part) => DISCOVERY_SKIP_DIRS.has(part))
  );
  const paths = new Set(store.projects.map((project) => project.path));
  store.version = 3;
  store.projects = await Promise.all(store.projects.map(async (project) => {
    const present = await pathExists(project.path);
    const markers = project.markers || [];
    const parentProjectPath = [...paths]
      .filter((candidate) => candidate !== project.path && isInside(project.path, candidate))
      .sort((a, b) => b.length - a.length)[0] || null;
    const contained = Boolean(parentProjectPath);
    const repository = hasRepositoryMarker(markers);
    const nested = !repository && contained;
    const inferred = project.category ? { kind: project.kind, category: project.category } : classifyMarkers(markers);
    const normalized = {
      ...project,
      ...inferred,
      ignored: Boolean(project.ignored),
      contained,
      nested,
      scope: repository ? 'repository' : nested ? 'nested' : 'standalone',
      parentProjectPath
    };
    if (present) return { ...normalized, status: 'present', missingSince: null };
    return { ...normalized, status: 'missing', missingSince: project.missingSince || new Date().toISOString() };
  }));
  return store;
}

async function detectProjects(root, maxDepth = 8) {
  const found = [];
  let inspectedDirectories = 0;

  async function visit(directory, depth, ancestorProjectPath = null) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
      inspectedDirectories += 1;
    } catch {
      return;
    }

    const names = new Set(entries.map((entry) => entry.name));
    const exactMarkers = [...PROJECT_MARKERS.keys()].filter((marker) => names.has(marker));
    const wildcardMarkers = entries.map((entry) => entry.name)
      .filter((name) => WILDCARD_MARKERS.some(([pattern]) => pattern.test(name)));
    const syntheticMarkers = [];
    if (names.has('HEAD') && names.has('objects') && names.has('refs')) syntheticMarkers.push('.git-bare');
    if (names.has('Assets') && names.has('ProjectSettings')) syntheticMarkers.push('Unity project');
    const markers = [...new Set([...exactMarkers, ...wildcardMarkers, ...syntheticMarkers])];
    let nextAncestor = ancestorProjectPath;
    if (markers.length) {
      const hasGit = hasRepositoryMarker(markers);
      const contained = Boolean(ancestorProjectPath);
      const nested = !hasGit && contained;
      const classification = classifyMarkers(markers, entries);
      found.push({
        path: directory,
        name: path.basename(directory),
        ...classification,
        markers,
        contained,
        nested,
        scope: hasGit ? 'repository' : nested ? 'nested' : 'standalone',
        parentProjectPath: ancestorProjectPath
      });
      nextAncestor = directory;
    }

    await Promise.all(entries
      .filter((entry) => entry.isDirectory() && !DISCOVERY_SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.'))
      .map((entry) => visit(path.join(directory, entry.name), depth + 1, nextAncestor)));
  }

  await visit(root, 0);
  return { found, inspectedDirectories };
}

async function directoryBreakdown(root) {
  const sizes = { totalSizeBytes: 0, sourceSizeBytes: 0, dependencySizeBytes: 0, generatedSizeBytes: 0, cacheSizeBytes: 0, vcsSizeBytes: 0 };
  async function visit(directory, bucket = 'sourceSizeBytes') {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entryPath === STORE_PATH || entryPath === `${STORE_PATH}.tmp`) return;
      let nextBucket = bucket;
      if (bucket === 'sourceSizeBytes') {
        if (entry.name === '.git') nextBucket = 'vcsSizeBytes';
        else if (DEPENDENCY_DIRS.has(entry.name)) nextBucket = 'dependencySizeBytes';
        else if (GENERATED_DIRS.has(entry.name)) nextBucket = 'generatedSizeBytes';
        else if (CACHE_DIRS.has(entry.name)) nextBucket = 'cacheSizeBytes';
      }
      if (entry.isDirectory()) return visit(entryPath, nextBucket);
      if (!entry.isFile()) return;
      try {
        const fileStats = await fs.stat(entryPath);
        const diskBytes = Number.isFinite(fileStats.blocks) ? fileStats.blocks * 512 : fileStats.size;
        sizes.totalSizeBytes += diskBytes;
        sizes[nextBucket] += diskBytes;
      } catch {}
    }));
  }
  await visit(root);
  return { ...sizes, reclaimableSizeBytes: sizes.dependencySizeBytes + sizes.generatedSizeBytes + sizes.cacheSizeBytes };
}

async function scan(scanRoot) {
  const root = path.resolve(scanRoot || os.homedir());
  const stats = await fs.stat(root);
  if (!stats.isDirectory()) throw new Error('The scan path must be a directory.');

  const previous = await readStore();
  const byPath = new Map(previous.projects.map((project) => [project.path, project]));
  const startedAt = Date.now();
  const { found, inspectedDirectories } = await detectProjects(root);
  const now = new Date().toISOString();

  const measured = [];
  for (let index = 0; index < found.length; index += 2) {
    const group = found.slice(index, index + 2);
    measured.push(...await Promise.all(group.map(async (project) => ({
      ...project,
      ...await directoryBreakdown(project.path)
    }))));
  }

  const seen = new Set(measured.map((project) => project.path));
  const currentProjects = measured.map((project) => {
    const old = byPath.get(project.path);
    const oldTotal = old?.totalSizeBytes ?? old?.sizeBytes;
    const change = !old ? 'new' : project.totalSizeBytes > oldTotal ? 'grew' : project.totalSizeBytes < oldTotal ? 'shrunk' : 'unchanged';
    return {
      ...project,
      sizeBytes: project.totalSizeBytes,
      status: 'present',
      change,
      ignored: Boolean(old?.ignored),
      previousSizeBytes: oldTotal ?? null,
      firstSeen: old?.firstSeen || now,
      lastSeen: now,
      missingSince: null
    };
  });

  const retained = previous.projects
    .filter((project) => !seen.has(project.path))
    .filter((project) => !project.path.split(path.sep).some((part) => DISCOVERY_SKIP_DIRS.has(part)))
    .map((project) => {
      if (!isInside(project.path, root)) return project;
      return {
        ...project,
        status: 'missing',
        change: 'missing',
        missingSince: project.missingSince || now
      };
    });

  const store = {
    version: 3,
    scanRoot: root,
    lastScanAt: now,
    scanDurationMs: Date.now() - startedAt,
    inspectedDirectories,
    projects: [...currentProjects, ...retained].sort((a, b) => a.name.localeCompare(b.name))
  };
  await writeStore(store);
  return store;
}

async function setIgnored(projectPaths, ignored) {
  const store = await readStore();
  const requested = new Set(Array.isArray(projectPaths) ? projectPaths : []);
  if (!requested.size) throw new Error('Select at least one project.');
  let updated = 0;
  store.version = 3;
  store.projects = store.projects.map((project) => {
    if (!requested.has(project.path)) return project;
    updated += 1;
    return { ...project, ignored: Boolean(ignored) };
  });
  if (!updated) throw new Error('No matching projects were found.');
  await writeStore(store);
  return store;
}

function json(response, status, data) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 10_000) throw new Error('Request is too large.');
  }
  return body ? JSON.parse(body) : {};
}

async function openProject(projectPath) {
  const store = await readStore();
  const exactMatch = store.projects.some((project) => project.path === projectPath);
  if (!exactMatch || !(await pathExists(projectPath))) throw new Error('Project is not available.');
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  const child = spawn(command, [projectPath], { detached: true, stdio: 'ignore' });
  child.unref();
}

async function serveStatic(urlPath, response) {
  const requested = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (!isInside(filePath, PUBLIC_DIR)) return json(response, 404, { error: 'Not found' });
  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    response.end(content);
  } catch {
    json(response, 404, { error: 'Not found' });
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
  try {
    if (request.method === 'GET' && url.pathname === '/api/projects') {
      const store = await refreshPresence(await readStore());
      await writeStore(store);
      return json(response, 200, store);
    }
    if (request.method === 'POST' && url.pathname === '/api/scan') {
      const { root } = await readBody(request);
      return json(response, 200, await scan(root));
    }
    if (request.method === 'POST' && url.pathname === '/api/open') {
      const { path: projectPath } = await readBody(request);
      await openProject(projectPath);
      return json(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/ignore') {
      const { paths, ignored } = await readBody(request);
      return json(response, 200, await setIgnored(paths, ignored));
    }
    if (request.method === 'GET') return serveStatic(url.pathname, response);
    json(response, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error(error);
    json(response, 400, { error: error.message || 'Something went wrong.' });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Local Project Index is running at http://${HOST}:${PORT}`);
    console.log(`Inventory will be saved to ${STORE_PATH}`);
  });
}

module.exports = { classifyMarkers, detectProjects, directoryBreakdown };
