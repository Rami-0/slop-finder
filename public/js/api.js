// Every call carries the custom header the server requires. A cross-site page
// cannot add it without a CORS preflight, which the server never approves.
const HEADERS = { 'content-type': 'application/json', 'x-slop-finder': '1' };

export async function request(url, { body, signal } = {}) {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal
  });
  let data = null;
  try {
    data = await response.json();
  } catch {}
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status}).`);
  return data;
}

export const api = {
  projects: () => request('/api/projects'),
  locations: () => request('/api/locations'),
  scan: (root) => request('/api/scan', { body: { root } }),
  ignore: (paths, ignored) => request('/api/ignore', { body: { paths, ignored } }),
  open: (path, reveal = false) => request('/api/open', { body: { path, reveal } }),
  browse: (path, extraRoots, signal) => request('/api/browse', { body: { path, extraRoots }, signal }),
  measure: (path, { fresh = false, signal } = {}) => request('/api/measure', { body: { path, fresh }, signal }),
  validateLocation: (path) => request('/api/locations/validate', { body: { path } }),
  preview: (paths, extraRoots) => request('/api/cleanup/preview', { body: { paths, extraRoots } }),
  execute: (planId, path, mode) => request('/api/cleanup/execute', { body: { planId, path, mode } }),
  system: () => request('/api/system'),
  githubStatus: (fresh = false) => request(`/api/github/status${fresh ? '?fresh=1' : ''}`),
  gitOverview: (paths) => request('/api/git/overview', { body: { paths } }),
  gitDetails: (path) => request('/api/git/details', { body: { path } }),
  gitCommit: (path, { message, fingerprint, acceptWarnings }) => request('/api/git/commit', { body: { path, message, fingerprint, acceptWarnings } }),
  gitPush: (path, branch = null) => request('/api/git/push', { body: { path, branch } }),
  githubCreate: (path, { name, visibility }) => request('/api/github/create', { body: { path, name, visibility } })
};
