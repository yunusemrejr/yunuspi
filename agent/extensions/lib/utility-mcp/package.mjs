import fs from 'node:fs';
import path from 'node:path';
import { within } from './files.mjs';

export function packageProbe(files, args) {
  const name = args.package;
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9_][a-z0-9._-]*$/i.test(name)) throw Error('Expected a package name without version or subpath');
  const project = files.resolve(args.project ?? '.', true);
  const parents = [];
  for (let at = project; within(files.root, at); at = path.dirname(at)) { parents.push(at); if (at === files.root) break; }
  const manifestFile = parents.map(p => path.join(p, 'package.json')).find(p => fs.existsSync(p));
  const manifest = manifestFile ? files.document(manifestFile) : {};
  const declarations = Object.fromEntries(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'].filter(k => Object.hasOwn(manifest[k] ?? {}, name)).map(k => [k, manifest[k][name]]));
  const installedFile = parents.map(p => path.join(p, 'node_modules', name, 'package.json')).find(p => fs.existsSync(p));
  const pkg = installedFile ? files.document(installedFile) : null;
  const lockFile = parents.flatMap(p => ['npm-shrinkwrap.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].map(n => path.join(p, n))).find(p => fs.existsSync(p));
  let lock = { status: 'absent' };
  if (lockFile) {
    const lockRoot = path.dirname(lockFile), basename = path.basename(lockFile);
    const candidates = [];
    let exact;
    if (basename.endsWith('.json')) {
      const data = files.document(lockFile);
      for (const [key, entry] of Object.entries(data.packages ?? {})) {
        if (key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`)) {
          const row = { key, ...resolution(entry) }; candidates.push(row);
          if (installedFile && path.resolve(lockRoot, key, 'package.json') === installedFile) exact = row;
        }
      }
      // npm lockfile v1 dependency hierarchy, bounded by parsed file size.
      if (!data.packages) {
        function visit(deps, prefix = '', depth = 0) {
          if (depth > 40) throw Error('Lock dependency nesting limit exceeded');
          for (const [dependency, entry] of Object.entries(deps ?? {})) {
            const key = `${prefix}node_modules/${dependency}`;
            if (dependency === name) {
              const row = { key, ...resolution(entry) }; candidates.push(row);
              if (installedFile && path.resolve(lockRoot, key, 'package.json') === installedFile) exact = row;
            }
            visit(entry.dependencies, `${key}/`, depth + 1);
          }
        }
        visit(data.dependencies);
      }
      // Follow npm workspace link entries to the actual lock record.
      if (exact && pkg && !exact.version) {
        const entry = data.packages?.[exact.key];
        if (entry?.link && data.packages?.[entry.resolved]) exact = { key: exact.key, link: entry.resolved, ...resolution(data.packages[entry.resolved]) };
      }
    } else if (basename === 'pnpm-lock.yaml') {
      const data = files.document(lockFile);
      const importerKey = path.relative(lockRoot, path.dirname(manifestFile ?? project)).replaceAll(path.sep, '/') || '.';
      const importer = data.importers?.[importerKey] ?? (data.importers ? {} : data);
      const selected = importer.dependencies?.[name] ?? importer.devDependencies?.[name] ?? importer.optionalDependencies?.[name];
      const selectedVersion = typeof selected === 'string' ? selected : selected?.version;
      for (const [key, entry] of Object.entries(data.packages ?? {})) {
        const normalized = key.replace(/^\//, '');
        if (normalized.startsWith(name + '@') || normalized.startsWith(name + '/')) {
          const version = normalized.slice(name.length + 1).split('(')[0].split('_')[0];
          const row = { key, version, resolution: entry.resolution }; candidates.push(row);
          if (selectedVersion && (normalized === name + '@' + selectedVersion || normalized === name + '/' + selectedVersion)) exact = row;
        }
      }
      lock.importer = importerKey;
      lock.declaration = selected ?? null;
    } else {
      // Yarn classic and Berry lock records are YAML mappings. A selector may
      // contain several comma-separated requests; match the full package name.
      const data = yarnLock(files, lockFile);
      for (const [key, entry] of Object.entries(data ?? {})) {
        if (key.split(/,\s*/).some(selector => selector.startsWith(name + '@'))) candidates.push({ key, ...resolution(entry) });
      }
      const directSelectors = Object.values(declarations).map(range => `${name}@${range}`);
      const matches = candidates.filter(r => r.key.split(/,\s*/).some(k => directSelectors.includes(k) || directSelectors.includes(k.replace('@npm:', '@'))));
      if (matches.length === 1) exact = matches[0];
    }
    const versionMatches = pkg ? candidates.filter(r => r.version === pkg.version) : [];
    lock = { ...lock, path: lockFile, status: exact ? 'exact-resolution' : versionMatches.length === 1 ? 'version-match-only' : 'unresolved',
      resolution: exact ?? null, installed_version_matches: versionMatches.slice(0, 20), candidates: candidates.slice(0, 50), candidates_total: candidates.length,
      matches_installed_version: exact && pkg ? exact.version === pkg.version : null };
  }
  return { package: name, project_manifest: manifestFile ?? null, declarations, relationship: Object.keys(declarations).length ? 'direct' : pkg ? 'transitive' : 'undeclared',
    installed: !!pkg, installed_version: pkg?.version ?? null, installed_name: pkg?.name ?? null,
    location: installedFile ? path.dirname(files.resolve(installedFile)) : null, resolution_path: installedFile ?? null,
    exports: pkg?.exports ?? null, main: pkg?.main ?? null, module: pkg?.module ?? null, types: pkg?.types ?? pkg?.typings ?? null,
    types_versions: pkg?.typesVersions ?? null, binaries: pkg?.bin ?? null, peer_dependencies: pkg?.peerDependencies ?? {}, peer_dependencies_meta: pkg?.peerDependenciesMeta ?? {}, scripts: pkg?.scripts ?? {}, lockfile: lock,
    limitations: ['Resolution is scoped to node_modules inside the workspace. Yarn Plug\u0027n\u0027Play virtual filesystems are not executed.', 'A lock version match alone is not an exact lock resolution.'] };
}
function resolution(entry) {
  return Object.fromEntries(['version', 'resolved', 'integrity', 'resolution', 'checksum', 'link'].filter(k => entry?.[k] !== undefined).map(k => [k, entry[k]]));
}

function yarnLock(files, file) {
  const text = files.read(file);
  if (/^__metadata:/m.test(text) || /^\s+version:/m.test(text)) return files.document(file);
  // Yarn classic's indented `version "1.2.3"` syntax is not a YAML mapping.
  // Read only package selectors and resolution scalars, without executing Yarn.
  const records = Object.create(null);
  let keys = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (/^\S.*:$/.test(line)) {
      keys = [...line.slice(0, -1).matchAll(/"(?:\\.|[^"\\])*"|[^,\s]+/g)].map(m => m[0].startsWith('"') ? JSON.parse(m[0]) : m[0]);
      for (const key of keys) records[key] = {};
    } else {
      const match = /^  (version|resolved|integrity) ("(?:\\.|[^"\\])*"|[^\s]+)\s*$/.exec(line);
      if (match) for (const key of keys) records[key][match[1]] = match[2].startsWith('"') ? JSON.parse(match[2]) : match[2];
    }
  }
  return records;
}
