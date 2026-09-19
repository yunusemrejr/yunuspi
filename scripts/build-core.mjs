#!/usr/bin/env node
// Build the owned ESM source. No downloads, package resolution or patch transforms.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parse } from 'acorn';
import { execFileSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = path.join(root, 'core');
const identity = JSON.parse(fs.readFileSync(path.join(core, 'identity.json'), 'utf8'));
const packages = fs.readdirSync(core).filter(name => fs.existsSync(path.join(core, name, 'package.json'))).sort();
const sourceHash = createHash('sha256');
let files = 0;
for (const name of packages) {
  const dir = path.join(core, name), source = path.join(dir, 'src');
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  if (!pkg.name.startsWith('@yunuspi/') || pkg.version !== identity.version) throw Error(`Invalid owned package: ${name}`);
  for (const group of ['dependencies', 'optionalDependencies']) {
    for (const [dep, version] of Object.entries(pkg[group] ?? {})) {
      if (dep.startsWith('@earendil-works/') || (dep.startsWith('@yunuspi/') && version !== identity.version)) throw Error(`Non-owned core dependency: ${dep}`);
    }
  }
  sourceHash.update(`${name}/package.json\0`).update(fs.readFileSync(path.join(dir, 'package.json')));
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw Error(`Invalid source file: ${file}`);
      if (entry.isDirectory()) { walk(file); continue; }
      const data = fs.readFileSync(file);
      if (entry.name.endsWith('.js')) parse(data.toString('utf8'), { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
      if (entry.name.endsWith('.json')) JSON.parse(data.toString('utf8'));
      sourceHash.update(`${name}/${path.relative(source, file)}\0`).update(data); files++;
    }
  };
  walk(source);
}
// All sources validate before replacing any output; install builds in a private stage.
for (const name of packages) {
  const dir = path.join(core, name);
  fs.rmSync(path.join(dir, 'dist'), { recursive: true, force: true });
  fs.cpSync(path.join(dir, 'src'), path.join(dir, 'dist'), { recursive: true });
}
let sourceCommit = process.env.YUNUSPI_SOURCE_COMMIT;
if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? '')) {
  try { sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { sourceCommit = null; }
}
const receipt = { ...identity, sourceCommit, sourceDigest: sourceHash.digest('hex'), packages: packages.length, files };
fs.writeFileSync(path.join(core, 'build.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(`Built ${identity.name} ${identity.version}: ${packages.length} packages, ${files} source files, sha256 ${receipt.sourceDigest}`);
