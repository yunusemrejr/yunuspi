/*
 * Pure, deliberately lossy parsers used by project-intelligence discovery.
 *
 * The parser layer never returns source snippets or configuration values.  It
 * extracts names and structural clues only; discovery attaches provenance and
 * deterministic node ids to the returned descriptors.
 */

const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cxx', '.cs', '.css', '.go', '.graphql', '.gql',
  '.h', '.hh', '.hpp', '.html', '.java', '.js', '.jsx', '.json', '.json5',
  '.kt', '.kts', '.less', '.lua', '.m', '.md', '.mjs', '.mts', '.php',
  '.pl', '.pm', '.py', '.rb', '.rs', '.sass', '.scss', '.sh', '.sql',
  '.swift', '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml', '.yaml', '.yml',
  '.zsh',
]);

const SOURCE_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cxx', '.cs', '.go', '.h', '.hh', '.hpp', '.java',
  '.js', '.jsx', '.kt', '.kts', '.lua', '.m', '.mjs', '.mts', '.php', '.pl',
  '.gql', '.graphql', '.pm', '.py', '.rb', '.rs', '.sql', '.swift', '.ts', '.tsx', '.vue',
]);

const DOC_BASENAMES = new Set([
  'readme', 'readme.md', 'readme.mdx', 'contributing.md', 'architecture.md',
  'design.md', 'overview.md', 'agents.md', 'workspace.md', 'operations.md',
  'deployment.md', 'runbook.md', 'changelog.md', 'changes.md', 'security.md',
  'license', 'license.md',
]);

const MANIFEST_BASENAMES = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml',
  'pnpm-workspace.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'deno.json',
  'deno.jsonc', 'cargo.toml', 'cargo.lock', 'go.mod', 'go.sum', 'go.work',
  'go.work.sum', 'pyproject.toml', 'poetry.lock', 'pipfile', 'pipfile.lock',
  'requirements.txt', 'requirements-dev.txt', 'setup.py', 'setup.cfg',
  'composer.json', 'composer.lock', 'gemfile', 'gemfile.lock', 'mix.exs',
  'mix.lock', 'build.gradle', 'build.gradle.kts', 'pom.xml', 'makefile',
  'cmakelists.txt', 'pubspec.yaml', 'pubspec.lock', 'mix.exs',
]);

const CONFIG_BASENAME_RE = /(?:^|[._-])(?:config|rc|settings|conf)(?:[._-]|$)/i;
const TEMPLATE_ENV_RE = /^(?:\.env(?:\.[^.]+)*\.(?:example|sample|template|dist|defaults?)|env(?:\.[^.]+)*\.(?:example|sample|template|dist|defaults?)|example\.env)$/i;
const ACTUAL_ENV_RE = /^(?:\.env(?:\.[^.]+)*|env(?:\.[^.]+)*)$/i;

const GENERATED_SEGMENTS = new Set([
  '.git', '.hg', '.svn', 'node_modules', 'bower_components', 'vendor',
  'dist', 'build', 'out', 'target', 'coverage', '.nyc_output', '.next',
  '.nuxt', '.svelte-kit', '.cache', '.parcel-cache', '.turbo', '.vite',
  '.pytest_cache', '__pycache__', '.mypy_cache', '.ruff_cache', '.tox',
  '.venv', 'venv', 'env', 'tmp', 'temp', 'logs', 'uploads', 'storage',
  '.terraform', '.gradle',
]);

const PROTECTED_BASENAME_RE = /^(?:credentials?|secrets?|secret|private(?:[-_.].*)?|id_rsa(?:[-_.].*)?|token(?:[-_.].*)?|service[-_.]?account(?:[-_.].*)?)$/i;
const PROTECTED_EXTENSION_RE = /\.(?:pem|key|p12|pfx|jks|kdb|keystore|der|crt)$/i;
const BINARY_EXTENSION_RE = /\.(?:7z|avi|bin|bmp|class|db|dmg|doc|docx|eot|exe|gif|gz|ico|jar|jpeg|jpg|mp3|mp4|otf|pdf|png|so|sqlite|sqlite3|tar|tif|tiff|ttf|wasm|webm|webp|woff|woff2|xls|xlsx|zip)$/i;

const FRAMEWORKS = new Map([
  ['@angular/core', 'Angular'], ['@nestjs/core', 'NestJS'], ['@remix-run/node', 'Remix'],
  ['@sveltejs/kit', 'SvelteKit'], ['@vue/cli-service', 'Vue CLI'], ['astro', 'Astro'],
  ['django', 'Django'], ['electron', 'Electron'], ['express', 'Express'],
  ['fastapi', 'FastAPI'], ['flask', 'Flask'], ['hono', 'Hono'], ['next', 'Next.js'],
  ['nuxt', 'Nuxt'], ['react', 'React'], ['react-native', 'React Native'],
  ['remix', 'Remix'], ['svelte', 'Svelte'], ['vue', 'Vue'], ['vite', 'Vite'],
  ['webpack', 'Webpack'], ['@playwright/test', 'Playwright'], ['cypress', 'Cypress'],
  ['jest', 'Jest'], ['vitest', 'Vitest'], ['tailwindcss', 'Tailwind CSS'],
  ['prisma', 'Prisma'], ['drizzle-orm', 'Drizzle'], ['sqlalchemy', 'SQLAlchemy'],
  ['rails', 'Ruby on Rails'], ['spring-boot', 'Spring Boot'], ['gin-gonic/gin', 'Gin'],
  ['actix-web', 'Actix Web'], ['axum', 'Axum'], ['rocket', 'Rocket'],
]);

const PACKAGE_MANAGER_BY_FILE = new Map([
  ['package.json', 'npm-compatible'], ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'], ['pnpm-lock.yaml', 'pnpm'],
  ['pnpm-workspace.yaml', 'pnpm'], ['yarn.lock', 'Yarn'], ['bun.lock', 'Bun'],
  ['bun.lockb', 'Bun'], ['cargo.toml', 'Cargo'], ['cargo.lock', 'Cargo'],
  ['go.mod', 'Go modules'], ['go.sum', 'Go modules'], ['go.work', 'Go workspaces'],
  ['poetry.lock', 'Poetry'], ['pipfile', 'Pipenv'], ['pipfile.lock', 'Pipenv'],
  ['requirements.txt', 'pip'], ['requirements-dev.txt', 'pip'],
  ['composer.json', 'Composer'], ['composer.lock', 'Composer'],
  ['gemfile', 'Bundler'], ['gemfile.lock', 'Bundler'], ['mix.exs', 'Mix'],
  ['mix.lock', 'Mix'], ['pubspec.yaml', 'Dart Pub'], ['pubspec.lock', 'Dart Pub'],
]);

const DEPENDENCY_SECTIONS = new Set([
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
  'bundledDependencies', 'bundleDependencies',
]);

function bounded(value, max = 180) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

function cleanName(value, max = 180) {
  return bounded(value, max).replace(/\s+/g, ' ');
}

// Version/range fields are useful for dependency orientation, but arbitrary
// manifest strings may contain credentials or private URLs. Keep only the
// small syntax family used by package managers and discard everything else.
function safeVersion(value) {
  const text = bounded(value, 100);
  if (!text || /(?:https?|ssh|git):\/\/|(?:password|passwd|secret|token|api[_-]?key|credential)\s*[:=]/i.test(text)) return '';
  return /^[A-Za-z0-9._+*~^<>=!:/|,()\[\]{}@ -]{1,100}$/.test(text) ? text : '';
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean).map(value => cleanName(value)))].sort((a, b) => a.localeCompare(b));
}

function objectLike(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function jsonValue(text) {
  try {
    const value = JSON.parse(text);
    return objectLike(value);
  } catch {
    return null;
  }
}

function tomlScalar(value) {
  const raw = value.trim().replace(/\s+#.*$/, '');
  if (!raw) return '';
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) return bounded(raw.slice(1, -1));
  if (raw.startsWith('[') && raw.endsWith(']')) {
    return raw.slice(1, -1).split(',').map(part => tomlScalar(part)).filter(Boolean);
  }
  return bounded(raw.split(/\s+/)[0]);
}

function tomlEntries(text) {
  const entries = [];
  let section = '';
  for (const line of text.split(/\r?\n/, 20000)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]/.exec(trimmed);
    if (header) { section = bounded(header[1], 160); continue; }
    const pair = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(trimmed);
    if (!pair) continue;
    entries.push({ section, key: bounded(pair[1], 120), value: tomlScalar(pair[2]) });
  }
  return entries;
}

function lineEntries(text) {
  return text.split(/\r?\n/, 24000);
}

function dependencyDescriptorsFromObject(data) {
  const dependencies = [];
  const frameworks = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const value = data?.[section];
    if (Array.isArray(value)) {
      for (const name of value.slice(0, 256)) if (typeof name === 'string') dependencies.push({ name: cleanName(name, 140), section, version: '' });
      continue;
    }
    if (!objectLike(value)) continue;
    for (const [name, version] of Object.entries(value).slice(0, 512)) {
      if (!/^[A-Za-z0-9@_./+:-]{1,160}$/.test(name)) continue;
      const versionText = typeof version === 'string' ? safeVersion(version) : '';
      dependencies.push({ name, section, version: versionText });
      const framework = FRAMEWORKS.get(name.toLowerCase());
      if (framework) frameworks.push({ name: framework, package: name });
    }
  }
  return { dependencies, frameworks };
}

function parsePackageJson(rel, text) {
  const data = jsonValue(text);
  if (!data) return { warnings: ['invalid JSON manifest'], dependencies: [], frameworks: [], scripts: [], workspaces: [] };
  const { dependencies, frameworks } = dependencyDescriptorsFromObject(data);
  const scripts = objectLike(data.scripts) ? Object.keys(data.scripts).slice(0, 128).filter(key => /^[A-Za-z0-9_.:@/-]{1,120}$/.test(key)) : [];
  let workspaces = [];
  if (Array.isArray(data.workspaces)) workspaces = data.workspaces.filter(value => typeof value === 'string').slice(0, 64).map(value => bounded(value, 160));
  else if (objectLike(data.workspaces) && Array.isArray(data.workspaces.packages)) workspaces = data.workspaces.packages.filter(value => typeof value === 'string').slice(0, 64).map(value => bounded(value, 160));
  const fields = {};
  for (const key of ['name', 'private', 'packageManager', 'type', 'main', 'module', 'types', 'browser']) {
    const value = data[key];
    if (typeof value === 'string' || typeof value === 'boolean') fields[key] = bounded(String(value), 180);
  }
  const engines = objectLike(data.engines) ? Object.keys(data.engines).slice(0, 16) : [];
  return { manifest: 'package', fields, dependencies, frameworks, scripts, workspaces, engines };
}

function parseJsonManifest(rel, text) {
  const base = rel.split('/').pop().toLowerCase();
  if (base === 'package.json') return parsePackageJson(rel, text);
  const data = jsonValue(text);
  if (!data) return { warnings: ['invalid JSON manifest/configuration'] };
  const keys = Object.keys(data).slice(0, 128).filter(key => /^[A-Za-z0-9_.:@/-]{1,160}$/.test(key));
  const fields = {};
  for (const key of ['name', 'version', 'framework', 'provider', 'project', 'service', 'buildCommand', 'outputDirectory', 'runtime', 'region']) {
    if (typeof data[key] === 'string') fields[key] = bounded(data[key]);
  }
  return { manifest: 'json', fields, keys, frameworks: [], dependencies: [], scripts: [], workspaces: [] };
}

function parseWorkspaceYaml(text) {
  const workspaces = [];
  let inPackages = false;
  for (const line of lineEntries(text)) {
    const trimmed = line.trim();
    if (/^packages\s*:/.test(trimmed)) { inPackages = true; continue; }
    if (inPackages && /^[-]\s+/.test(trimmed)) {
      const value = trimmed.replace(/^[-]\s+/, '').replace(/^['"]|['"]$/g, '');
      if (value) workspaces.push(bounded(value, 160));
      continue;
    }
    if (inPackages && /^\S[^:]*:/.test(trimmed)) inPackages = false;
  }
  return { manifest: 'workspace', workspaces: uniqueSorted(workspaces), dependencies: [], frameworks: [], scripts: [] };
}

function parseRequirements(text) {
  const dependencies = [];
  for (const line of lineEntries(text)) {
    const value = line.trim();
    if (!value || value.startsWith('#') || value.startsWith('-')) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,140})(?:\[[^\]]+\])?\s*(.*)$/.exec(value);
    if (match) dependencies.push({ name: match[1], section: 'requirements', version: safeVersion(match[2]) });
    if (dependencies.length >= 512) break;
  }
  const frameworks = dependencies.flatMap(({ name }) => {
    const framework = FRAMEWORKS.get(name.toLowerCase());
    return framework ? [{ name: framework, package: name }] : [];
  });
  return { manifest: 'requirements', dependencies, frameworks, scripts: [], workspaces: [] };
}

function parseGoMod(text) {
  const dependencies = [];
  let module = '';
  for (const line of lineEntries(text)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('module ')) module = bounded(trimmed.slice(7));
    const match = /^(?:require\s+)?([^\s(]+)(?:\s+v?([^\s]+))?$/.exec(trimmed);
    if (match && (trimmed.startsWith('require ') || /^[A-Za-z0-9][^\s]+\s+v\d/.test(trimmed))) dependencies.push({ name: match[1], section: 'go', version: safeVersion(match[2] ?? '') });
  }
  const frameworks = dependencies.flatMap(({ name }) => {
    const framework = FRAMEWORKS.get(name.toLowerCase()) || [...FRAMEWORKS.entries()].find(([key]) => name.toLowerCase().includes(key))?.[1];
    return framework ? [{ name: framework, package: name }] : [];
  });
  return { manifest: 'go', fields: { module }, dependencies, frameworks, scripts: [], workspaces: [] };
}

function parseCargo(text) {
  const entries = tomlEntries(text);
  const dependencies = [];
  let packageName = '';
  for (const entry of entries) {
    if (entry.section === 'package' && entry.key === 'name' && typeof entry.value === 'string') packageName = entry.value;
    if (entry.section === 'dependencies' || entry.section.startsWith('workspace.dependencies')) {
      dependencies.push({ name: entry.key, section: 'cargo', version: typeof entry.value === 'string' ? safeVersion(entry.value) : '' });
    }
  }
  const frameworks = dependencies.flatMap(({ name }) => {
    const framework = FRAMEWORKS.get(name.toLowerCase());
    return framework ? [{ name: framework, package: name }] : [];
  });
  return { manifest: 'cargo', fields: { name: packageName }, dependencies, frameworks, scripts: [], workspaces: [] };
}

function parseTomlManifest(base, text) {
  if (base === 'cargo.toml') return parseCargo(text);
  const entries = tomlEntries(text);
  const dependencies = [];
  let name = '';
  for (const entry of entries) {
    if (['project', 'tool.poetry', 'package'].includes(entry.section) && entry.key === 'name' && typeof entry.value === 'string') name ||= entry.value;
    if (/^(?:project|tool\.poetry)\.(?:dependencies|dev-dependencies)$/.test(entry.section) || entry.section === 'dependencies') dependencies.push({ name: entry.key, section: 'toml', version: Array.isArray(entry.value) ? '' : safeVersion(String(entry.value ?? '')) });
    if (entry.section === 'build-system' && entry.key === 'requires' && Array.isArray(entry.value)) for (const item of entry.value) dependencies.push({ name: String(item).split(/[<>=!~\[]/)[0].trim(), section: 'build-system', version: safeVersion(String(item)) });
  }
  const frameworks = dependencies.flatMap(({ name: dependencyName }) => {
    const framework = FRAMEWORKS.get(dependencyName.toLowerCase());
    return framework ? [{ name: framework, package: dependencyName }] : [];
  });
  return { manifest: 'toml', fields: { name }, dependencies, frameworks, scripts: [], workspaces: [] };
}

function parseMakefile(text) {
  const scripts = [];
  for (const line of lineEntries(text)) {
    const match = /^([A-Za-z0-9_.-]{1,100})\s*:(?!=)/.exec(line);
    if (match && !scripts.includes(match[1])) scripts.push(match[1]);
    if (scripts.length >= 128) break;
  }
  return { manifest: 'make', scripts, dependencies: [], frameworks: [], workspaces: [] };
}

function parseGemfile(text) {
  const dependencies = [];
  for (const line of lineEntries(text)) {
    const match = /^\s*gem\s+['"]([^'"]{1,140})['"]/.exec(line);
    if (match) dependencies.push({ name: match[1], section: 'gem', version: '' });
    if (dependencies.length >= 512) break;
  }
  return { manifest: 'gem', dependencies, frameworks: [], scripts: [], workspaces: [] };
}

export function parseManifest(rel, text) {
  const base = rel.split('/').pop().toLowerCase();
  if (base === 'package.json' || base.endsWith('.json')) return parseJsonManifest(rel, text);
  if (base === 'pnpm-workspace.yaml') return parseWorkspaceYaml(text);
  if (base === 'requirements.txt' || base === 'requirements-dev.txt' || base === 'pipfile') return parseRequirements(text);
  if (base === 'go.mod') return parseGoMod(text);
  if (base === 'cargo.toml') return parseCargo(text);
  if (base === 'pyproject.toml') return parseTomlManifest(base, text);
  if (base === 'gemfile') return parseGemfile(text);
  if (base === 'makefile' || base === 'cmakelists.txt') return parseMakefile(text);
  const packageManager = PACKAGE_MANAGER_BY_FILE.get(base) ?? '';
  return { manifest: 'lockfile', fields: packageManager ? { packageManager } : {}, dependencies: [], frameworks: [], scripts: [], workspaces: [] };
}

function importMatches(text, ext) {
  const imports = [];
  const add = (specifier, kind = 'import') => {
    const value = bounded(specifier, 240);
    if (!value || imports.some(item => item.specifier === value)) return;
    imports.push({ specifier: value, kind });
  };
  if (['.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx', '.vue'].includes(ext)) {
    const re = /(?:^|[;\n])\s*(?:import\s+(?:[\s\S]*?\s+from\s+)?|export\s+[\s\S]*?\s+from\s+)['"]([^'"]+)['"]|\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;
    for (const match of text.matchAll(re)) add(match[1] ?? match[2], 'javascript import');
    const sideEffect = /\bimport\s*['"]([^'"]+)['"]/g;
    for (const match of text.matchAll(sideEffect)) add(match[1], 'javascript import');
  } else if (ext === '.py') {
    for (const match of text.matchAll(/^\s*from\s+([A-Za-z0-9_.-]+)\s+import\s+/gm)) add(match[1], 'python import');
    for (const match of text.matchAll(/^\s*import\s+([A-Za-z0-9_., -]+)/gm)) for (const item of match[1].split(',')) add(item.trim().split(/\s+as\s+/)[0], 'python import');
  } else if (ext === '.go') {
    for (const match of text.matchAll(/^\s*"([^"]+)"\s*$/gm)) add(match[1], 'go import');
  } else if (ext === '.rs') {
    for (const match of text.matchAll(/^\s*(?:use|extern\s+crate|mod)\s+([A-Za-z0-9_:.\-/]+)/gm)) add(match[1], 'rust import');
  } else if (ext === '.rb') {
    for (const match of text.matchAll(/^\s*require(?:_relative)?\s+['"]([^'"]+)['"]/gm)) add(match[1], 'ruby import');
  } else if (ext === '.php') {
    for (const match of text.matchAll(/^\s*(?:use|require|require_once|include|include_once)\s*['"]?([^'";\s]+)['"]?/gm)) add(match[1], 'php import');
  } else if (['.java', '.kt', '.kts'].includes(ext)) {
    for (const match of text.matchAll(/^\s*import\s+([A-Za-z0-9_.*]+)/gm)) add(match[1], 'jvm import');
  } else if (['.cs'].includes(ext)) {
    for (const match of text.matchAll(/^\s*using\s+([A-Za-z0-9_.]+)/gm)) add(match[1], 'dotnet import');
  }
  return imports.slice(0, 128);
}

function apiMatches(text, rel) {
  const apis = [];
  const add = (method, route, kind) => {
    const normalized = cleanName(route, 180).split(/[?#]/, 1)[0];
    if (!normalized || !normalized.startsWith('/') || normalized.includes(' ')) return;
    if (!apis.some(item => item.route === normalized && item.method === method)) apis.push({ method: bounded(method || 'route', 24).toUpperCase(), route: normalized, kind });
  };
  const routeRe = /\b(?:app|router|server|api|routes?)\s*\.\s*(get|post|put|patch|delete|head|options|all|use)\s*\(\s*[`'\"]([^`'\"]{1,180})[`'\"]/gim;
  for (const match of text.matchAll(routeRe)) add(match[1], match[2], 'router declaration');
  const decoratorRe = /@(?:Get|Post|Put|Patch|Delete|Head|Options|RequestMapping)\s*\(\s*['"]([^'"]{1,180})['"]/g;
  for (const match of text.matchAll(decoratorRe)) add('route', match[1], 'route decorator');
  const httpRe = /\b(?:fetch|axios\.(?:get|post|put|patch|delete)|requests\.(?:get|post|put|patch|delete)|http\.(?:Get|Post|NewRequest))\s*\(\s*[`'\"]([^`'\"]{1,180})[`'\"]/g;
  for (const match of text.matchAll(httpRe)) if (match[1].startsWith('/')) add('request', match[1], 'HTTP client path');
  for (const match of text.matchAll(/\b(?:type\s+(?:Query|Mutation|Subscription)|schema\s*\{|extend\s+type\s+(?:Query|Mutation))/g)) add('graphql', '/graphql', 'GraphQL schema clue');
  const normalizedRel = rel.toLowerCase().replaceAll('\\', '/');
  if (/(?:^|\/)(?:pages|app|src\/routes?)(?:\/|$)/.test(normalizedRel) && /(?:^|\/)(?:api|route|routes?)(?:[./\/]|$)/.test(normalizedRel)) {
    const route = '/' + normalizedRel.replace(/\.(?:[cm]?[jt]sx?|vue|svelte|py|rb|go)$/, '').replace(/^.*?\/pages\//, '').replace(/^.*?\/app\//, '').replace(/^src\/routes?\//, '').replace(/\/index$/, '').replace(/\/route$/, '');
    if (route.length > 1) add('route', route.replace(/\[([^\]]+)\]/g, ':$1'), 'conventional route path');
  }
  return apis.slice(0, 64);
}

function schemaMatches(text, rel) {
  const tables = [];
  const add = (name, kind) => {
    const value = cleanName(name, 140).replace(/["'`]/g, '');
    if (!value || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value)) return;
    if (!tables.some(item => item.name.toLowerCase() === value.toLowerCase())) tables.push({ name: value, kind });
  };
  for (const match of text.matchAll(/\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_.-]*)/gim)) add(match[1], 'SQL table');
  for (const match of text.matchAll(/^\s*model\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm)) add(match[1], 'Prisma model');
  for (const match of text.matchAll(/\b(?:table|sqliteTable|mysqlTable|pgTable)\s*\(\s*['"]([^'"]+)['"]/g)) add(match[1], 'ORM table');
  for (const match of text.matchAll(/^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:type|interface)\b/gm)) add(match[1], 'schema type');
  for (const match of text.matchAll(/^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/gm)) add(match[1], 'GraphQL/object type');
  return tables.slice(0, 96);
}

function environmentMatches(text, ext) {
  const names = [];
  const add = value => {
    const name = cleanName(value, 120);
    if (/^[A-Z][A-Z0-9_]{1,119}$/.test(name) && !names.includes(name)) names.push(name);
  };
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.mts' || ext === '.ts' || ext === '.tsx' || ext === '.vue' || ext === '.svelte') {
    for (const match of text.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]*)/g)) add(match[1]);
    for (const match of text.matchAll(/\bprocess\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)) add(match[1]);
  }
  if (ext === '.py') for (const match of text.matchAll(/\bos\.getenv\s*\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g)) add(match[1]);
  if (ext === '.rb') for (const match of text.matchAll(/\bENV\[['"]([A-Z][A-Z0-9_]*)['"]\]/g)) add(match[1]);
  if (ext === '.rs') for (const match of text.matchAll(/\benv::var\s*\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g)) add(match[1]);
  if (ext === '.go') for (const match of text.matchAll(/\bos\.Getenv\s*\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g)) add(match[1]);
  return names.slice(0, 96).sort();
}

function componentMatches(text, ext) {
  if (!['.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx', '.vue', '.svelte'].includes(ext)) return [];
  const names = [];
  for (const match of text.matchAll(/\b(?:export\s+(?:default\s+)?|default\s+)?(?:function|class)\s+([A-Z][A-Za-z0-9_]*)/g)) names.push(match[1]);
  for (const match of text.matchAll(/\b(?:export\s+)?const\s+([A-Z][A-Za-z0-9_]*)\s*=/g)) names.push(match[1]);
  return uniqueSorted(names).slice(0, 48);
}

export function parseCode(rel, text) {
  const ext = rel.includes('.') ? '.' + rel.split('.').pop().toLowerCase() : '';
  return {
    imports: importMatches(text, ext),
    apis: apiMatches(text, rel),
    tables: schemaMatches(text, rel),
    environmentVariables: environmentMatches(text, ext),
    components: componentMatches(text, ext),
  };
}

function yamlSafeValue(value) {
  const raw = value.trim().replace(/\s+#.*$/, '').replace(/^['"]|['"]$/g, '');
  if (!raw || /(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|authorization)/i.test(raw) || /:\S+@/.test(raw)) return '';
  if (/^(?:https?|ssh|git):\/\//i.test(raw)) return raw.split(/[?#]/, 1)[0].slice(0, 180);
  if (/^[A-Za-z0-9_.:@/+{}$\[\]-]{1,180}$/.test(raw)) return raw.slice(0, 180);
  return '';
}

export function parseDeployment(rel, text) {
  const base = rel.split('/').pop().toLowerCase();
  const result = { deployment: true, platform: '', keys: [], actions: [], environments: [], safeValues: [], pipelines: [] };
  const lower = rel.toLowerCase();
  if (lower.includes('.github/workflows')) result.platform = 'GitHub Actions';
  else if (base === '.gitlab-ci.yml') result.platform = 'GitLab CI';
  else if (base === 'azure-pipelines.yml') result.platform = 'Azure Pipelines';
  else if (base === 'jenkinsfile') result.platform = 'Jenkins';
  else if (base === 'dockerfile' || base.startsWith('dockerfile.')) result.platform = 'Docker';
  else if (base.includes('compose')) result.platform = 'Docker Compose';
  else if (base === 'fly.toml') result.platform = 'Fly.io';
  else if (base === 'vercel.json' || base === 'vercel.toml') result.platform = 'Vercel';
  else if (base === 'netlify.toml' || base === '_redirects') result.platform = 'Netlify';
  else if (base === 'render.yaml' || base === 'render.yml') result.platform = 'Render';
  else if (base === 'railway.json' || base === 'railway.toml') result.platform = 'Railway';
  else if (lower.includes('/k8s/') || lower.includes('/kubernetes/') || lower.includes('/helm/')) result.platform = 'Kubernetes';
  else if (lower.includes('/terraform/') || lower.endsWith('.tf')) result.platform = 'Terraform';
  else if (base === 'procfile') result.platform = 'Procfile';
  else if (lower.includes('serverless')) result.platform = 'Serverless';
  else if (/(?:^|\/)(?:deploy|release|publish|provision|migrate)(?:[-_.].*)?\.(?:sh|bash|zsh|ps1|cmd|bat)$/i.test(rel)) result.platform = 'deployment script (not executed)';
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) {
    for (const line of lineEntries(text)) {
      const trimmed = line.trim();
      const from = /^FROM\s+([^\s]+)/i.exec(trimmed);
      if (from) result.safeValues.push({ key: 'baseImage', value: bounded(from[1], 160) });
      const expose = /^EXPOSE\s+(.+)/i.exec(trimmed);
      if (expose) result.safeValues.push({ key: 'port', value: bounded(expose[1].split('#')[0], 80) });
      const env = /^(?:ENV|ARG)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(trimmed);
      if (env) result.environments.push(env[1]);
      const command = /^(?:CMD|ENTRYPOINT|HEALTHCHECK)\b/i.exec(trimmed);
      if (command) result.actions.push(trimmed.split(/\s+/, 1)[0].toUpperCase());
    }
  } else {
    const lines = lineEntries(text);
    for (const line of lines) {
      const trimmed = line.trim();
      const pair = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*(.*)$/.exec(trimmed.replace(/^[-]\s+/, ''));
      if (pair) {
        const key = bounded(pair[1], 120);
        if (!result.keys.includes(key)) result.keys.push(key);
        const safe = yamlSafeValue(pair[2]);
        if (safe && ['provider', 'project', 'service', 'name', 'image', 'region', 'runtime', 'build', 'deploy', 'command', 'working_dir', 'root_dir'].includes(key.toLowerCase())) result.safeValues.push({ key, value: safe });
        if (/^(?:environment|env|variables)$/i.test(key)) result.environments.push('declared environment');
        if (/^(?:steps?|jobs?|commands?|scripts?|uses?)$/i.test(key)) result.pipelines.push(key);
      }
      const uses = /^[-\s]*uses?\s*:\s*([^\s#]+)/i.exec(trimmed);
      if (uses && /^(?:[A-Za-z0-9_.-]+\/){1,2}[A-Za-z0-9_.-]+(?:@[^\s]+)?$/.test(uses[1])) result.actions.push(bounded(uses[1], 160));
      const env = /^[-\s]*(?:env|environment|variables?)\s*:\s*([A-Z][A-Z0-9_]*)/i.exec(trimmed);
      if (env) result.environments.push(env[1]);
    }
  }
  result.keys = uniqueSorted(result.keys).slice(0, 128);
  result.actions = uniqueSorted(result.actions).slice(0, 128);
  result.environments = uniqueSorted(result.environments).slice(0, 128);
  result.pipelines = uniqueSorted(result.pipelines).slice(0, 64);
  return result;
}

export function parseEnvTemplate(text) {
  const names = [];
  for (const line of lineEntries(text)) {
    const trimmed = line.trim();
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|:)/.exec(trimmed);
    if (match && !names.includes(match[1])) names.push(match[1]);
    if (names.length >= 256) break;
  }
  return names.sort();
}

export function parseApiSpec(text) {
  const apis = [];
  let inPaths = false;
  let currentPath = '';
  const add = (method, route) => {
    const normalized = bounded(route, 180).split(/[?#]/, 1)[0];
    if (!normalized.startsWith('/') || !/^[a-z]+$/i.test(method) || !/^[\/A-Za-z0-9_.:{}$\[\]-]+$/.test(normalized)) return;
    if (!apis.some(item => item.method === method.toUpperCase() && item.route === normalized)) apis.push({ method: method.toUpperCase(), route: normalized, kind: 'OpenAPI/Swagger path' });
  };
  for (const line of lineEntries(text)) {
    const trimmed = line.trim();
    if (/^["']?paths["']?\s*:/.test(trimmed)) { inPaths = true; currentPath = ''; continue; }
    if (inPaths && /^\S[^:]*:\s*/.test(line) && !/^\s*["']?\//.test(line)) { inPaths = false; currentPath = ''; }
    if (!inPaths) continue;
    const route = /^\s{2,}["']?(\/[^"':\s]{1,180})["']?\s*:/.exec(line);
    if (route) { currentPath = route[1]; continue; }
    const method = /^\s{4,}(get|post|put|patch|delete|head|options|trace)\s*:/.exec(line);
    if (method && currentPath) add(method[1], currentPath);
  }
  // JSON OpenAPI documents do not have indentation-sensitive YAML keys.  A
  // bounded route/method pair scan gives the same structural result without
  // retaining the JSON values or descriptions.
  for (const match of text.matchAll(/["'](\/[A-Za-z0-9_.:{}$\[\]-]{1,180})["']\s*:\s*\{([\s\S]{0,12000})\}/g)) {
    for (const method of match[2].matchAll(/["'](get|post|put|patch|delete|head|options|trace)["']\s*:/gi)) add(method[1], match[1]);
  }
  return { apis: apis.slice(0, 128) };
}

export function parseDoc(rel, text) {
  const headings = [];
  const links = [];
  for (const line of lineEntries(text)) {
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) headings.push(cleanName(heading[1], 180));
    const link = /!?\[[^\]]{0,160}\]\(([^)\s]{1,240})[^)]*\)/g;
    for (const match of line.matchAll(link)) {
      const target = bounded(match[1], 240).split(/[?#]/, 1)[0];
      if (target && !links.includes(target)) links.push(target);
    }
    if (headings.length >= 64 && links.length >= 128) break;
  }
  const purpose = headings.find(value => /overview|about|purpose|architecture|what|introduction/i.test(value)) ?? headings[0] ?? '';
  return { headings: uniqueSorted(headings).slice(0, 64), links: uniqueSorted(links).slice(0, 128), purpose };
}

export function isTemplateEnvPath(rel) {
  const base = rel.split('/').pop();
  return TEMPLATE_ENV_RE.test(base);
}

export function isActualEnvPath(rel) {
  const base = rel.split('/').pop();
  return ACTUAL_ENV_RE.test(base) && !isTemplateEnvPath(rel);
}

export function isProtectedPath(rel) {
  const parts = rel.split('/');
  const base = parts.at(-1) ?? '';
  if (isActualEnvPath(rel)) return true;
  if (PROTECTED_BASENAME_RE.test(base) || PROTECTED_EXTENSION_RE.test(base)) return true;
  return parts.some(part => /^(?:secrets?|credentials?|private)$/i.test(part));
}

export function isGeneratedPath(rel) {
  return rel.split('/').some(segment => GENERATED_SEGMENTS.has(segment.toLowerCase()));
}

export function isTextPath(rel) {
  const base = rel.split('/').pop()?.toLowerCase() ?? '';
  if (BINARY_EXTENSION_RE.test(base)) return false;
  const dot = base.lastIndexOf('.');
  return dot === -1 || TEXT_EXTENSIONS.has(base.slice(dot));
}

export function isSourcePath(rel) {
  const base = rel.split('/').pop()?.toLowerCase() ?? '';
  const dot = base.lastIndexOf('.');
  return SOURCE_EXTENSIONS.has(dot >= 0 ? base.slice(dot) : '');
}

export function isDocPath(rel) {
  const base = rel.split('/').pop()?.toLowerCase() ?? '';
  return DOC_BASENAMES.has(base) || (/(?:^|\/)docs?\//i.test(rel) && /\.(?:md|mdx|txt|rst)$/i.test(base));
}

export function isManifestPath(rel) {
  const base = rel.split('/').pop()?.toLowerCase() ?? '';
  return MANIFEST_BASENAMES.has(base);
}

export function isConfigPath(rel) {
  const base = rel.split('/').pop()?.toLowerCase() ?? '';
  return CONFIG_BASENAME_RE.test(base) || /^(?:tsconfig(?:\..*)?|jsconfig(?:\..*)?|\.editorconfig|\.nvmrc|\.node-version|\.python-version|\.ruby-version|\.tool-versions|\.dockerignore|\.gitignore|\.gitattributes|\.npmrc|\.prettierrc(?:\..*)?|\.eslintrc(?:\..*)?|openapi\.(?:json|yaml|yml)|swagger\.(?:json|yaml|yml)|schema\.(?:graphql|gql|json|yaml|yml)|graphql\.(?:yaml|yml))$/i.test(base);
}

export function isDeploymentPath(rel) {
  const base = rel.split('/').pop()?.toLowerCase() ?? '';
  const lower = rel.toLowerCase();
  return base === 'dockerfile' || base.startsWith('dockerfile.') || base === 'procfile' || base === '.gitlab-ci.yml' || base === 'azure-pipelines.yml' || base === 'jenkinsfile' || base === 'fly.toml' || base === 'vercel.json' || base === 'vercel.toml' || base === 'netlify.toml' || base === 'render.yaml' || base === 'render.yml' || base === 'railway.json' || base === 'railway.toml' || base === 'docker-compose.yml' || base === 'docker-compose.yaml' || base === 'compose.yml' || base === 'compose.yaml' || lower.includes('.github/workflows/') || lower.includes('/k8s/') || lower.includes('/kubernetes/') || lower.includes('/helm/') || lower.includes('/terraform/') || lower.endsWith('.tf') || lower.includes('serverless') || /(?:^|\/)(?:deploy|release|publish|provision|migrate)(?:[-_.].*)?\.(?:sh|bash|zsh|ps1|cmd|bat)$/i.test(rel);
}

export function isDiscoverablePath(rel) {
  if (isProtectedPath(rel) || isGeneratedPath(rel) || !isTextPath(rel)) return false;
  return isManifestPath(rel) || isDocPath(rel) || isConfigPath(rel) || isDeploymentPath(rel) || isTemplateEnvPath(rel) || isSourcePath(rel) || /\.(?:sql|graphql|gql)$/i.test(rel) || /(?:^|\/)(?:scripts?|migrations?|schema|schemas?|routes?|api|components?|lib|app|src|packages?|services?)\//i.test(rel);
}

export function redactRemote(value) {
  const raw = bounded(value, 500);
  if (!raw) return { value: '', host: '', transport: '', path: '' };
  // Git's scp-like syntax is not a URL. Parse it before handing anything to
  // URL so a username can never become part of a persisted path.
  const scp = /^(?:[^@\s]+@)?([^:\/\s]+):(.+)$/.exec(raw);
  if (scp && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) {
    const pathname = scp[2].split(/[?#]/, 1)[0].replace(/^\/+/, '').slice(0, 180);
    return { value: `ssh://${scp[1]}${pathname ? '/' + pathname : ''}`.slice(0, 300), host: scp[1].slice(0, 160), transport: 'ssh', path: pathname ? '/' + pathname : '' };
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { value: '', host: '', transport: '', path: '' };
  }
  const protocol = parsed.protocol.replace(/:$/, '').toLowerCase();
  const host = parsed.hostname.slice(0, 160);
  const pathname = parsed.pathname.replace(/^\/+/, '').slice(0, 180);
  const valueOut = `${protocol}://${host}${pathname ? '/' + pathname : ''}`.slice(0, 300);
  return { value: valueOut, host, transport: protocol, path: pathname ? '/' + pathname : '' };
}

export function basenameSet() {
  return { docs: new Set(DOC_BASENAMES), manifests: new Set(MANIFEST_BASENAMES) };
}
