#!/usr/bin/env node
// Installs only the reviewed public agent tree; never imports local credentials.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
let apply = false, backupExisting = false, preserveState = false, deps = false, needle = true, offline = false, target = path.join(os.homedir(), '.pi', 'agent');
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--apply') apply = true;
  else if (arg === '--backup-existing') backupExisting = true;
  else if (arg === '--preserve-state') preserveState = true;
  else if (arg === '--install-deps') deps = true;
  else if (arg === '--offline') { offline = true; deps = true; }
  else if (arg === '--with-needle') needle = true;
  else if (arg === '--skip-needle') needle = false;
  else if (arg === '--target' && args[i + 1] && !args[i + 1].startsWith('--')) target = path.resolve(args[++i]);
  else if (arg === '--help') {
    console.log('node scripts/install.mjs [--apply] [--install-deps|--offline] [--backup-existing] [--preserve-state] [--with-needle|--skip-needle] [--target PATH]\nDefault is a read-only dry run. --install-deps builds the repository-owned YunusPi core. --offline uses cached npm dependencies and skips optional asset downloads. --target is for staging; full harness runtime expects ~/.pi/agent.\nNeedle3 local-semantic assets (~36MB, pinned official build) download during --apply unless --skip-needle; a failed download warns and never fails the install (repair later with: node <agent>/extensions/lib/needle-assets.mjs repair).');
    process.exit(0);
  } else throw Error(`Unknown or incomplete argument: ${arg}`);
}
const source = path.join(repo, 'agent');
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
function assertTree(directory, skipped = new Set(['node_modules'])) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw Error(`Source contains a link or special file: ${path.relative(repo, file)}`);
    if (stat.isDirectory()) assertTree(file, skipped);
  }
}
function assertAncestors(destination) {
  for (let cursor = destination; ; cursor = path.dirname(cursor)) {
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw Error(`Destination ancestor is a symlink: ${cursor}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cursor === path.dirname(cursor)) break;
  }
}
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function sourceInventory(directory, core = false) {
  const files = Object.create(null);
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || (core && entry.name === 'dist') || (core && current === directory && entry.name === 'build.json')) continue;
      const file = path.join(current, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw Error(`Source inventory contains a link or special file: ${path.relative(directory, file)}`);
      if (entry.isDirectory()) visit(file);
      else files[path.relative(directory, file)] = digest(file);
    }
  };
  visit(directory);
  return files;
}
// Carry private local state only between installations. This inventory never
// enters the public source tree and stores paths/digests, never file contents.
function carryState(previous, stage, incoming, incomingCore) {
  const receiptFile = path.join(previous, 'installation.json');
  if (!fs.existsSync(receiptFile) || !fs.lstatSync(receiptFile).isFile() || fs.lstatSync(receiptFile).isSymbolicLink())
    throw Error('State-preserving update requires an installation receipt; review a manual migration or use the explicit fresh backup installation.');
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  const validMap = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length;
  if (receipt.product !== 'YunusPi' || !validMap(receipt.managedFiles) || !validMap(receipt.managedCoreFiles))
    throw Error('State-preserving update requires managed-file hashes; review a manual migration or use the explicit fresh backup installation.');
  const tracked = Object.assign(Object.create(null), receipt.managedFiles);
  const trackedCore = Object.assign(Object.create(null), receipt.managedCoreFiles);
  const excluded = relative => ['runtime', 'bin', 'installation.json'].includes(relative.split(path.sep)[0])
    || ['extensions/node_modules', 'npm/node_modules'].includes(relative);
  for (const [relative, hash] of Object.entries(tracked)) {
    if (path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part => !part || part === '..' || part === '.') || relative.includes('\0') || excluded(relative) || !/^[a-f0-9]{64}$/.test(hash))
      throw Error('Invalid managed-file inventory; preserve the installation for review.');
  }
  for (const [relative, hash] of Object.entries(trackedCore)) {
    if (path.isAbsolute(relative) || relative.includes('\\') || relative.split('/').some(part => !part || part === '..' || part === '.') || relative.includes('\0') || !/^[a-f0-9]{64}$/.test(hash))
      throw Error('Invalid managed-core inventory; preserve the installation for review.');
  }
  const previousCore = path.join(previous, 'runtime/core');
  assertAncestors(previousCore);
  const actualCore = sourceInventory(previousCore, true);
  for (const relative of new Set([...Object.keys(trackedCore), ...Object.keys(actualCore)])) {
    if (actualCore[relative] === trackedCore[relative] || actualCore[relative] === incomingCore[relative]) continue;
    throw Error(`Local owned-core source conflicts with the incoming release: ${relative}. Port the local change into the reviewed source checkout before updating; the current installation is retained.`);
  }
  const conflict = relative => { throw Error(`Local source conflicts with the incoming release: ${relative}. Port or review the local change before updating; the current installation is retained.`); };
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name), relative = path.relative(previous, file);
      if (excluded(relative)) continue;
      const stat = fs.lstatSync(file), destination = path.join(stage, relative);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw Error(`Cannot preserve a symlink or special state file: ${relative}`);
      if (stat.isDirectory()) {
        if (incoming[relative]) conflict(relative);
        fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
        visit(file);
        continue;
      }
      const actual = digest(file), baseline = tracked[relative], next = incoming[relative];
      if (baseline && actual === baseline) continue; // replace/remove managed source
      if ((baseline && next !== baseline && next !== actual) || (!baseline && next && next !== actual)) conflict(relative);
      if (fs.existsSync(destination) && fs.lstatSync(destination).isDirectory()) conflict(relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.copyFileSync(file, destination);
      fs.chmodSync(destination, stat.mode & 0o700);
    }
  };
  visit(previous);
  for (const [relative, baseline] of Object.entries(tracked)) {
    if (fs.existsSync(path.join(previous, relative))) continue;
    if (incoming[relative] && incoming[relative] !== baseline) conflict(relative);
    fs.rmSync(path.join(stage, relative), { force: true });
  }
}
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) throw Error('Use Node.js 22.19 or newer; Node.js 24+ is recommended.');
if (process.platform === 'win32') throw Error('Run this installer inside WSL2 Ubuntu. Native Windows parity is not supported; see docs/PLATFORMS.md.');
if (!fs.existsSync(path.join(source, 'extensions', 'manifest.json'))) throw Error('Public agent tree missing; use a complete release checkout.');
assertTree(source);
assertTree(path.join(repo, 'core'), new Set(['node_modules', 'dist']));
if (fs.existsSync(path.join(repo, 'docs'))) assertTree(path.join(repo, 'docs'));
for (const file of ['package.json', 'package-lock.json', 'scripts/build-core.mjs']) {
  const stat = fs.lstatSync(path.join(repo, file));
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error(`Missing regular owned-core build input: ${file}`);
}
const coreManifest = JSON.parse(fs.readFileSync(path.join(repo, 'core/coding-agent/package.json'), 'utf8'));
if (coreManifest.name !== '@yunuspi/coding-agent') throw Error('Expected the YunusPi-owned core; external Pi packages are not supported');
assertAncestors(target);
if (inside(target, repo) || inside(repo, target)) throw Error('Destination must not overlap this repository.');
if (target === path.parse(target).root || target === os.homedir()) throw Error('Destination must be a dedicated agent directory.');
const existing = fs.existsSync(target);
const initialDestination = existing ? fs.lstatSync(target) : null;
if (initialDestination && !initialDestination.isDirectory()) throw Error('Existing destination is not a directory.');
const revision = fs.existsSync(path.join(repo, '.git')) ? spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }) : null;
const sourceCommit = revision && !revision.error && revision.status === 0 && /^[a-f0-9]{40}$/.test(revision.stdout.trim()) ? revision.stdout.trim() : null;
if (existing && !backupExisting) throw Error('Destination exists. Use a new target, or explicitly --backup-existing after stopping Pi. No files were changed.');
if (preserveState && (!existing || !backupExisting)) throw Error('--preserve-state requires an existing installation and --backup-existing.');
console.log(`${apply ? 'Install' : 'Dry run'}: public agent tree and YunusPi-owned core → ${target}`);
console.log(`Dependencies: ${deps ? `npm ci --ignore-scripts + build:core (${offline ? 'offline cache only' : 'third-party dependency download'})` : 'not installed'}; existing installation: ${existing ? (preserveState ? 'private backup plus staged state preservation' : 'will be renamed to a private backup, fresh defaults') : 'none'}`);
console.log(`Needle3 local-semantic assets: ${needle && !offline ? 'pinned official build (~36MB download)' : 'skipped (offline or --skip-needle)'}`);
if (preserveState) console.log('Private state and compatible local customizations will carry forward; source conflicts or unsafe links reject the update.');
if (!apply) process.exit(0);
// Stop replacements while a maintained launcher holds the installation's lease.
// The inherited descriptor stays attached to the old directory after its rename.
if (existing) {
  const lock = path.join(target, 'logs/harness-session.lock');
  assertAncestors(lock);
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  let held = false;
  try {
    const current = fs.fstatSync(9), expected = fs.statSync(lock);
    held = process.env.YUNUSPI_INSTALL_LOCK_HELD === '1' && current.dev === expected.dev && current.ino === expected.ino
      && spawnSync('flock', ['-n', '9'], { stdio: ['ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 9] }).status === 0;
  } catch {}
  if (!held) {
    const locked = spawnSync('/bin/bash', ['-c', 'exec 9>"$1"; flock -n -E 75 9 || exit $?; export YUNUSPI_INSTALL_LOCK_HELD=1; exec "$2" "${@:3}"', 'yunuspi-install-lock', lock, process.execPath, fileURLToPath(import.meta.url), ...args], { stdio: 'inherit' });
    if (locked.status === 75) console.error('YunusPi sessions are active; installation was not replaced.');
    process.exit(locked.status ?? 1);
  }
}
fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
const stage = fs.mkdtempSync(path.join(path.dirname(target), '.yunuspi-install-'));
let backup;
try {
  const managedFiles = sourceInventory(source);
  const managedCoreFiles = sourceInventory(path.join(repo, 'core'), true);
  fs.cpSync(source, stage, { recursive: true, force: false, errorOnExist: true, filter: file => !path.relative(source, file).split(path.sep).includes('node_modules') });
  fs.chmodSync(stage, 0o700);
  for (const name of ['settings', 'models']) {
    const sample = path.join(repo, 'config', `${name}.example.json`);
    if (!fs.lstatSync(sample).isFile() || fs.lstatSync(sample).isSymbolicLink()) throw Error(`Missing regular public ${name} example`);
    const content = fs.readFileSync(sample, 'utf8');
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error(`Invalid public ${name} example`);
    fs.writeFileSync(path.join(stage, `${name}.json`), content, { flag: 'wx', mode: 0o600 });
  }
  if (preserveState) carryState(target, stage, managedFiles, managedCoreFiles);
  const runtime = path.join(stage, 'runtime');
  fs.mkdirSync(path.join(runtime, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(runtime, '.npmrc'), 'ignore-scripts=true\naudit=false\nfund=false\n');
  fs.mkdirSync(path.join(runtime, 'agent/npm'), { recursive: true });
  for (const name of ['package.json', 'package-lock.json', 'scripts/build-core.mjs']) fs.copyFileSync(path.join(repo, name), path.join(runtime, name));
  for (const name of ['README.md', 'AGENTS.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'UPSTREAM-PORTING.md']) {
    const file = path.join(repo, name);
    if (!fs.existsSync(file)) continue;
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw Error(`Documentation input must be a regular file: ${name}`);
    fs.copyFileSync(file, path.join(runtime, name));
  }
  if (fs.existsSync(path.join(repo, 'docs'))) fs.cpSync(path.join(repo, 'docs'), path.join(runtime, 'docs'), { recursive: true });
  for (const name of ['package.json', 'package-lock.json']) {
    const file = path.join(source, 'npm', name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(runtime, 'agent/npm', name));
  }
  fs.cpSync(path.join(repo, 'core'), path.join(runtime, 'core'), { recursive: true, filter: file => !file.split(path.sep).some(part => ['node_modules', 'dist', '.git'].includes(part)) });
  if (deps) {
    const result = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', ...(offline ? ['--offline'] : [])], { cwd: runtime, stdio: 'inherit', timeout: 300000 });
    if (result.error || result.status !== 0) throw Error(`Dependency install failed: ${result.error?.message ?? result.status}`);
    const build = spawnSync('npm', ['run', 'build:core'], { cwd: runtime, stdio: 'inherit', timeout: 300000, env: { ...process.env, ...(sourceCommit ? { YUNUSPI_SOURCE_COMMIT: sourceCommit } : {}) } });
    if (build.error || build.status !== 0) throw Error(`Owned core build failed: ${build.error?.message ?? build.status}`);
  }
  fs.symlinkSync('../runtime/node_modules', path.join(stage, 'extensions', 'node_modules'), 'dir');
  fs.symlinkSync('../runtime/node_modules', path.join(stage, 'npm', 'node_modules'), 'dir');
  fs.mkdirSync(path.join(stage, 'bin'));
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(path.join(stage, 'bin/yunuspi'), `#!/usr/bin/env bash
set -euo pipefail
AGENT="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
export PI_CODING_AGENT_DIR="$AGENT"
export PATH="$AGENT/bin:$PATH"
export PI_SUBAGENT_PI_BINARY="$AGENT/bin/yunuspi"
export YUNUSPI_CORE_ROOT="$AGENT/runtime/core/coding-agent"
exec /bin/bash "$AGENT/scripts/pi-launch.sh" ${quote(process.execPath)} "$YUNUSPI_CORE_ROOT/dist/cli.js" "$@"
`, { mode: 0o755 });
  fs.symlinkSync('yunuspi', path.join(stage, 'bin/pi'));
  fs.writeFileSync(path.join(stage, 'installation.json'), JSON.stringify({ product: 'YunusPi', core: coreManifest.name, coreVersion: coreManifest.version, source: 'repository-owned', sourceCommit, built: deps, managedFiles, managedCoreFiles }, null, 2) + '\n', { mode: 0o600 });
  // Recheck at the mutation boundary; never follow destination symlinks.
  assertAncestors(target);
  if (fs.existsSync(target)) {
    if (!backupExisting || !existing) throw Error('Destination appeared during installation; refusing replacement.');
    const currentDestination = fs.lstatSync(target);
    if (currentDestination.dev !== initialDestination.dev || currentDestination.ino !== initialDestination.ino) throw Error('Destination changed during installation; refusing replacement.');
    backup = `${target}.backup-${Date.now()}-${process.pid}`;
    if (fs.existsSync(backup)) throw Error('Backup destination already exists.');
    if (!fs.lstatSync(target).isDirectory()) throw Error('Existing destination is not a directory.');
    fs.renameSync(target, backup);
  }
  try {
    if (backup) fs.chmodSync(backup, 0o700);
    fs.renameSync(stage, target);
  }
  catch (error) { if (backup && !fs.existsSync(target)) fs.renameSync(backup, target); throw error; }
  console.log(`Public files installed. ${backup ? `Previous installation preserved at ${backup}. ` : ''}${deps ? `Launch ${target}/bin/yunuspi; add ${target}/bin to PATH.` : 'Source copied only. Install dependencies and build before launching; see docs/INSTALL.md.'}`);
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
// Needle3 assets: pinned, checksummed, atomic. A missing manager (minimal
// fixture trees), offline network, or corrupt download warns and never fails
// the install: Needle degrades gracefully and repairs on demand.
if (needle && !offline) {
  try {
    const manager = await import(pathToFileURL(path.join(target, 'extensions/lib/needle-assets.mjs')).href).catch(() => null);
    if (!manager?.installAssets) {
      console.log('Needle3 assets: manager unavailable in this distribution; skipping (repair later with needle-assets.mjs).');
    } else {
      const receipt = await manager.installAssets({ agentDir: target });
      console.log(`Needle3 assets: ${receipt.installed ? receipt.note : 'already installed and verified'}.`);
    }
  } catch (error) {
    console.log(`Needle3 assets: download unavailable (${String(error?.message ?? error).slice(0, 160)}). Install continues without local semantics; repair later with: node ${target}/extensions/lib/needle-assets.mjs repair`);
  }
}
