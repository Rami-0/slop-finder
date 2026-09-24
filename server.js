const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { HOME, HOST, PORT, PUBLIC_DIR, STORE_PATH } = require('./lib/config');
const { isInside } = require('./lib/paths');
const scanner = require('./lib/scanner');
const safety = require('./lib/safety');
const inspect = require('./lib/inspect');
const cleanup = require('./lib/cleanup');
const github = require('./lib/github');
const repos = require('./lib/repos');
const { systemInfo } = require('./lib/system');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8'
};

const MAX_BODY_BYTES = 1_000_000;
const ALLOWED_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((host) => `http://${host}`));

// The page may never be framed (so a hostile site cannot trick a click onto
// "Delete"), and it loads nothing from anywhere but this server.
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cache-control': 'no-store'
};

// Any website open in the browser can send requests to 127.0.0.1 as well.
// Checking Host defeats DNS rebinding, and the custom header forces a CORS
// preflight for cross-site requests, which this server never approves.
function requestRejection(request, isApi) {
  if (!ALLOWED_HOSTS.has(request.headers.host)) return [421, `Open the app at http://${HOST}:${PORT}.`];
  if (!isApi) return null;
  const origin = request.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return [403, 'Cross-site requests are not allowed.'];
  if (request.headers['x-slop-finder'] !== '1') return [403, 'Requests must come from the Slop Finder page.'];
  if (request.method === 'POST' && !String(request.headers['content-type'] || '').startsWith('application/json')) {
    return [415, 'Requests must be JSON.'];
  }
  return null;
}

function json(response, status, data) {
  response.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) throw new Error('Request is too large.');
  }
  if (!body) return {};
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('Request body is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Request body must be a JSON object.');
  return parsed;
}

function spawnDetached(command, args) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', (error) => console.error(`Could not run ${command}:`, error.message));
  child.unref();
}

// `open` launches apps and runs installers, so anything that is not a plain
// folder is revealed in Finder rather than opened.
const BUNDLE_PATTERN = /\.(app|pkg|mpkg|bundle|framework|plugin|appex|kext|prefpane|saver|qlgenerator|workflow|action|xpc)$/i;

async function openPath(target, { reveal = false } = {}) {
  if (!safety.isNormalizedAbsolute(target)) throw new Error('Choose an absolute path.');
  let real;
  let stats;
  try {
    real = await fs.realpath(target);
    stats = await fs.stat(real);
  } catch {
    throw new Error('That item no longer exists.');
  }
  const revealInstead = reveal || !stats.isDirectory() || BUNDLE_PATTERN.test(real);
  if (process.platform === 'darwin') return spawnDetached('open', revealInstead ? ['-R', real] : [real]);
  if (process.platform === 'win32') return spawnDetached('explorer.exe', revealInstead ? [`/select,${real}`] : [real]);
  return spawnDetached('xdg-open', [revealInstead ? path.dirname(real) : real]);
}

function withMeta(store) {
  return { ...store, home: HOME };
}

const routes = {
  'GET /api/projects': async () => withMeta(await scanner.loadProjects()),
  'GET /api/locations': async () => safety.describeLocations(),
  'POST /api/scan': async ({ body }) => withMeta(await scanner.scan(body.root)),
  'POST /api/ignore': async ({ body }) => withMeta(await scanner.setIgnored(body.paths, body.ignored)),
  'POST /api/open': async ({ body }) => {
    await openPath(body.path, { reveal: Boolean(body.reveal) });
    return { ok: true };
  },
  'POST /api/browse': async ({ body }) => inspect.browse(body.path, { extraRoots: body.extraRoots }),
  'POST /api/measure': async ({ body, signal }) => inspect.measure(body.path, { fresh: Boolean(body.fresh), signal }),
  'POST /api/locations/validate': async ({ body }) => ({ path: await safety.resolveExtraRoot(body.path) }),
  'POST /api/cleanup/preview': async ({ body }) => cleanup.createPlan(body.paths, { extraRoots: body.extraRoots }),
  'POST /api/cleanup/execute': async ({ body }) => {
    const result = await cleanup.executeItem(body);
    return { ...result, store: withMeta(result.store) };
  },
  'GET /api/system': async () => systemInfo(),
  'GET /api/github/status': async ({ url }) => github.publicStatus(await github.status({ fresh: url.searchParams.get('fresh') === '1' })),
  'POST /api/git/overview': async ({ body }) => repos.overviews(body.paths),
  'POST /api/git/details': async ({ body }) => repos.details(body.path),
  'POST /api/git/commit': async ({ body }) => repos.commit(body),
  'POST /api/git/push': async ({ body }) => repos.push(body),
  'POST /api/github/create': async ({ body }) => repos.createRemote(body)
};

async function serveStatic(urlPath, response) {
  const requested = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.slice(1));
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (!isInside(filePath, PUBLIC_DIR)) return json(response, 404, { error: 'Not found' });
  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, { ...SECURITY_HEADERS, 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    response.end(content);
  } catch {
    json(response, 404, { error: 'Not found' });
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${HOST}:${PORT}`);
  const isApi = url.pathname.startsWith('/api/');
  const rejection = requestRejection(request, isApi);
  if (rejection) return json(response, rejection[0], { error: rejection[1] });
  try {
    if (isApi) {
      const route = routes[`${request.method} ${url.pathname}`];
      if (!route) return json(response, 404, { error: 'Unknown endpoint.' });
      // Navigating away cancels long folder measurements instead of letting them run on.
      const controller = new AbortController();
      response.on('close', () => {
        if (!response.writableFinished) controller.abort();
      });
      const body = request.method === 'POST' ? await readBody(request) : {};
      return json(response, 200, await route({ body, signal: controller.signal, url }));
    }
    if (request.method === 'GET' || request.method === 'HEAD') return serveStatic(url.pathname, response);
    json(response, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error(error.message || error);
    json(response, 400, { error: error.message || 'Something went wrong.' });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`Slop Finder is running at http://${HOST}:${PORT}`);
    console.log(`Inventory will be saved to ${STORE_PATH}`);
  });
}

module.exports = {
  classifyMarkers: scanner.classifyMarkers,
  createReclaimEvent: scanner.createReclaimEvent,
  detectProjects: scanner.detectProjects,
  directoryBreakdown: scanner.directoryBreakdown,
  requestRejection,
  server
};
