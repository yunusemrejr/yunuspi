#!/usr/bin/env node
// Installs only the reviewed public agent tree; never imports local credentials.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
let apply = false, backupExisting = false, deps = false, target = path.join(os.homedir(), '.pi', 'agent');
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--apply') apply = true;
  else if (arg === '--backup-existing') backupExisting = true;
  else if (arg === '--install-deps') deps = true;
  else if (arg === '--target' && args[i + 1] && !args[i + 1].startsWith('--')) target = path.resolve(args[++i]);
  else if (arg === '--help') {
    console.log('node scripts/install.mjs [--apply] [--install-deps] [--backup-existing] [--target PATH]\nDefault is a read-only dry run. --target is for staging; runtime expects ~/.pi/agent.');
    process.exit(0);
  } else throw Error(`Unknown or incomplete argument: ${arg}`);
}
const source = path.join(repo, 'agent');
const inside = (child, parent) => child === parent || child.startsWith(parent + path.sep);
function assertTree(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw Error(`Source contains a link or special file: ${path.relative(repo, file)}`);
    if (stat.isDirectory()) assertTree(file);
  }
}
function assertAncestors(destination) {
  for (let cursor = destination; ; cursor = path.dirname(cursor)) {
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw Error(`Destination ancestor is a symlink: ${cursor}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cursor === path.dirname(cursor)) break;
  }
}
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) throw Error('Use Node.js 22.19 or newer; Node.js 24+ is recommended.');
if (process.platform === 'win32') throw Error('Run this installer inside WSL2 Ubuntu. Native Windows parity is not supported; see docs/PLATFORMS.md.');
if (!fs.existsSync(path.join(source, 'extensions', 'manifest.json'))) throw Error('Public agent tree missing; use a complete release checkout.');
assertTree(source);
assertAncestors(target);
if (inside(target, repo) || inside(repo, target)) throw Error('Destination must not overlap this repository.');
if (target === path.parse(target).root || target === os.homedir()) throw Error('Destination must be a dedicated agent directory.');
const existing = fs.existsSync(target);
if (existing && !backupExisting) throw Error('Destination exists. Use a new target, or explicitly --backup-existing after stopping Pi. No files were changed.');
console.log(`${apply ? 'Install' : 'Dry run'}: public agent tree → ${target}`);
console.log(`Dependencies: ${deps ? 'npm ci --ignore-scripts (network download)' : 'not installed'}; existing installation: ${existing ? 'will be renamed to a private backup, never merged' : 'none'}`);
if (!apply) process.exit(0);
fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
const stage = fs.mkdtempSync(path.join(path.dirname(target), '.yunuspi-install-'));
let backup;
try {
  fs.cpSync(source, stage, { recursive: true, force: false, errorOnExist: true });
  for (const name of ['settings', 'models']) {
    const sample = path.join(repo, 'config', `${name}.example.json`);
    if (!fs.lstatSync(sample).isFile() || fs.lstatSync(sample).isSymbolicLink()) throw Error(`Missing regular public ${name} example`);
    const content = fs.readFileSync(sample, 'utf8');
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error(`Invalid public ${name} example`);
    fs.writeFileSync(path.join(stage, `${name}.json`), content, { flag: 'wx', mode: 0o600 });
  }
  if (deps) {
    const result = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: path.join(stage, 'npm'), stdio: 'inherit', timeout: 300000 });
    if (result.error || result.status !== 0) throw Error(`Dependency install failed: ${result.error?.message ?? result.status}`);
  }
  fs.symlinkSync('../npm/node_modules', path.join(stage, 'extensions', 'node_modules'), 'dir');
  // Recheck at the mutation boundary; never follow destination symlinks.
  assertAncestors(target);
  if (fs.existsSync(target)) {
    if (!backupExisting) throw Error('Destination appeared during installation; refusing replacement.');
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
  console.log(`Public files installed. ${backup ? `Previous installation preserved at ${backup}. ` : ''}Follow docs/INSTALL.md to install and validate the pinned core before running Pi.`);
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
