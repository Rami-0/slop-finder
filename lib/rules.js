const path = require('node:path');
const { isInside } = require('./paths');

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

// Folders that project tooling recreates on demand. `bucket` picks the size column
// they count toward. `ambiguous` marks names some projects use for hand-written
// files (a committed `vendor/`, `build/` scripts); the cleanup preview checks those
// against Git before selecting them. `requires`/`requiresMatch` limit a rule to
// folders whose parent holds the named sibling files.
const ARTIFACT_RULES = [
  { name: 'node_modules', bucket: 'dependency', label: 'Node packages' },
  { name: 'bower_components', bucket: 'dependency', label: 'Bower packages' },
  { name: '.venv', bucket: 'dependency', label: 'Python virtualenv' },
  { name: 'venv', bucket: 'dependency', label: 'Python virtualenv' },
  { name: '.tox', bucket: 'dependency', label: 'tox environments' },
  { name: 'vendor', bucket: 'dependency', label: 'Vendored packages', ambiguous: true },
  { name: 'Pods', bucket: 'dependency', label: 'CocoaPods' },
  { name: '.bundle', bucket: 'dependency', label: 'Bundler gems' },
  { name: '.dart_tool', bucket: 'dependency', label: 'Dart packages' },
  { name: '.terraform', bucket: 'dependency', label: 'Terraform providers' },
  { name: 'deps', bucket: 'dependency', label: 'Mix dependencies', requires: ['mix.exs'] },

  { name: 'dist', bucket: 'generated', label: 'Build output', ambiguous: true },
  { name: 'build', bucket: 'generated', label: 'Build output', ambiguous: true },
  { name: 'out', bucket: 'generated', label: 'Build output', ambiguous: true },
  { name: 'target', bucket: 'generated', label: 'Compiled output', ambiguous: true },
  { name: '.next', bucket: 'generated', label: 'Next.js build' },
  { name: '.nuxt', bucket: 'generated', label: 'Nuxt build' },
  { name: '.output', bucket: 'generated', label: 'Nitro build' },
  { name: '.svelte-kit', bucket: 'generated', label: 'SvelteKit build' },
  { name: '.docusaurus', bucket: 'generated', label: 'Docusaurus build' },
  { name: 'storybook-static', bucket: 'generated', label: 'Storybook build' },
  { name: 'cdk.out', bucket: 'generated', label: 'CDK synth output' },
  { name: '.serverless', bucket: 'generated', label: 'Serverless package' },
  { name: '.aws-sam', bucket: 'generated', label: 'SAM build' },
  { name: 'coverage', bucket: 'generated', label: 'Coverage report' },
  { name: 'DerivedData', bucket: 'generated', label: 'Xcode build data' },
  { name: '.stack-work', bucket: 'generated', label: 'Stack build' },
  { name: 'zig-out', bucket: 'generated', label: 'Zig output' },
  { name: '_build', bucket: 'generated', label: 'Mix build', requires: ['mix.exs'] },
  { name: 'bin', bucket: 'generated', label: '.NET binaries', requiresMatch: /\.(cs|fs|vb)proj$/i },
  { name: 'obj', bucket: 'generated', label: '.NET intermediates', requiresMatch: /\.(cs|fs|vb)proj$/i },

  { name: '.cache', bucket: 'cache', label: 'Tool cache' },
  { name: '.turbo', bucket: 'cache', label: 'Turborepo cache' },
  { name: '.parcel-cache', bucket: 'cache', label: 'Parcel cache' },
  { name: '.angular', bucket: 'cache', label: 'Angular cache' },
  { name: '.expo', bucket: 'cache', label: 'Expo cache' },
  { name: '.gradle', bucket: 'cache', label: 'Gradle cache' },
  { name: '.sass-cache', bucket: 'cache', label: 'Sass cache' },
  { name: '__pycache__', bucket: 'cache', label: 'Python bytecode' },
  { name: '.pytest_cache', bucket: 'cache', label: 'pytest cache' },
  { name: '.mypy_cache', bucket: 'cache', label: 'mypy cache' },
  { name: '.ruff_cache', bucket: 'cache', label: 'Ruff cache' },
  { name: '.zig-cache', bucket: 'cache', label: 'Zig cache' },
  { name: 'zig-cache', bucket: 'cache', label: 'Zig cache' },
  { name: 'Library', bucket: 'cache', label: 'Unity import cache', requires: ['Assets', 'ProjectSettings'] },
  { name: '.godot', bucket: 'cache', label: 'Godot import cache', requires: ['project.godot'] }
];

const RULES_BY_NAME = new Map();
for (const rule of ARTIFACT_RULES) {
  if (!RULES_BY_NAME.has(rule.name)) RULES_BY_NAME.set(rule.name, []);
  RULES_BY_NAME.get(rule.name).push(rule);
}

function matchArtifactRule(name, siblings = new Set()) {
  const candidates = RULES_BY_NAME.get(name);
  if (!candidates) return null;
  return candidates.find((rule) =>
    (!rule.requires || rule.requires.every((required) => siblings.has(required))) &&
    (!rule.requiresMatch || [...siblings].some((sibling) => rule.requiresMatch.test(sibling)))
  ) || null;
}

// Discovery never descends into generated or dependency folders, so manifests
// inside them (every package in node_modules has a package.json) are not projects.
const DISCOVERY_SKIP_DIRS = new Set([
  '.git', '.hg', '.svn', '.coverage',
  'Library', 'Applications', 'Movies', 'Music', 'Pictures', '.Trash',
  ...ARTIFACT_RULES.filter((rule) => !rule.requires && !rule.requiresMatch).map((rule) => rule.name)
]);

// Operating-system and package-manager trees never hold the user's projects.
// macOS firmlinks /Users, /opt and /private into /System/Volumes/Data, so walking
// /System from `/` would find every project a second time under another path.
const DISCOVERY_SKIP_PATHS = process.platform === 'darwin'
  ? ['/System', '/Library', '/usr', '/bin', '/sbin', '/cores', '/dev', '/private/var', '/private/etc', '/opt/homebrew', '/opt/local', '/nix']
  : ['/proc', '/sys', '/dev', '/run', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/boot', '/etc', '/var', '/snap', '/nix'];
const DISCOVERY_SKIP_PATH_SET = new Set(DISCOVERY_SKIP_PATHS);

// A stored project under a skipped tree is noise, unless the user deliberately
// scanned inside that tree.
function isSystemPath(candidate, scanRoot = path.sep) {
  return DISCOVERY_SKIP_PATHS.some((skip) => isInside(candidate, skip) && !isInside(scanRoot, skip));
}

const NODE_LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm install'], ['yarn.lock', 'yarn install'], ['bun.lock', 'bun install'],
  ['bun.lockb', 'bun install'], ['package-lock.json', 'npm ci'], ['npm-shrinkwrap.json', 'npm ci']
];

function nodeInstallCommand(names) {
  return NODE_LOCKFILES.find(([lockfile]) => names.has(lockfile))?.[1] || null;
}

// Facts a folder hands down to everything beneath it during a walk. Workspace
// packages share the lockfile at the monorepo root, so the install command for
// apps/web/node_modules comes from an ancestor.
function inheritContext(context, names) {
  const nodeInstall = nodeInstallCommand(names);
  return nodeInstall ? { ...context, nodeInstall } : context;
}

function restoreInfo(rule, siblings = new Set(), context = {}) {
  const has = (name) => siblings.has(name);
  const run = (command, note = null) => ({ command, note });
  const explain = (note) => ({ command: null, note });
  switch (rule.name) {
    case 'node_modules': {
      const install = nodeInstallCommand(siblings) || context.nodeInstall;
      return install ? run(install) : run('npm install', 'No lockfile nearby, so a reinstall may pick newer versions.');
    }
    case 'bower_components': return run('bower install');
    case '.venv':
    case 'venv':
      if (has('uv.lock')) return run('uv sync');
      if (has('poetry.lock')) return run('poetry install');
      if (has('Pipfile') || has('Pipfile.lock')) return run('pipenv install');
      if (has('requirements.txt')) return run(`python3 -m venv ${rule.name} && ${rule.name}/bin/pip install -r requirements.txt`);
      if (has('pyproject.toml')) return run(`python3 -m venv ${rule.name} && ${rule.name}/bin/pip install -e .`);
      return explain('No requirements file next to it, so note the packages you need before deleting.');
    case '.tox': return explain('tox recreates its environments on the next run.');
    case 'vendor':
      if (has('composer.json')) return run('composer install');
      if (has('Gemfile')) return run('bundle install');
      if (has('go.mod')) return run('go mod vendor');
      return explain('No package manifest next to it. Check that nothing here was written by hand.');
    case 'Pods': return run('pod install');
    case '.bundle': return run('bundle install');
    case '.dart_tool': return run('flutter pub get', 'Use dart pub get for non-Flutter packages.');
    case '.terraform': return run('terraform init');
    case 'deps': return run('mix deps.get');
    case 'target':
      if (has('Cargo.toml')) return run('cargo build');
      if (has('pom.xml')) return run('mvn package');
      return explain('Rebuilt by the next build.');
    case '.next': return explain('Rebuilt by next dev or next build.');
    case 'DerivedData': return explain('Xcode rebuilds it on the next build.');
    case 'coverage': return explain('Recreated the next time tests run with coverage.');
    default:
      return explain(rule.bucket === 'cache' ? 'Recreated automatically the next time the tool runs.' : 'Rebuilt by the next build.');
  }
}

module.exports = {
  PROJECT_MARKERS,
  WILDCARD_MARKERS,
  SOURCE_EXTENSIONS,
  ARTIFACT_RULES,
  DISCOVERY_SKIP_DIRS,
  DISCOVERY_SKIP_PATHS,
  DISCOVERY_SKIP_PATH_SET,
  matchArtifactRule,
  isSystemPath,
  inheritContext,
  restoreInfo
};
