#!/usr/bin/env node
// npm lifecycle scripts stay disabled. This is the explicit, pinned Electron
// runtime setup; @electron/get verifies upstream distribution checksums.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const offline = args.includes('--offline');
const sourceIndex = args.indexOf('--source-root');
const source = sourceIndex >= 0 ? path.resolve(args[sourceIndex + 1]) : null;
const packageRoot = path.join(root, 'node_modules/electron');
const version = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;
const registerOnly = args.includes('--register-only');
if (registerOnly) {
  if (!fs.existsSync(path.join(packageRoot, 'dist/version')) || fs.readFileSync(path.join(packageRoot, 'dist/version'), 'utf8').trim().replace(/^v/, '') !== version) throw Error('Install the matching Electron runtime before registering its desktop entry.');
} else if (offline) {
  const from = source && path.join(source, 'node_modules/electron');
  if (!from || !fs.existsSync(path.join(from, 'dist/version')) || fs.readFileSync(path.join(from, 'dist/version'), 'utf8').trim().replace(/^v/, '') !== version
    || JSON.parse(fs.readFileSync(path.join(from, 'package.json'), 'utf8')).version !== version) throw Error('Offline desktop installation needs the matching Electron distribution in the source checkout. Run npm run setup:desktop there once with a network connection.');
  if (path.resolve(from) !== path.resolve(packageRoot)) {
    fs.cpSync(path.join(from, 'dist'), path.join(packageRoot, 'dist'), { recursive: true });
    fs.copyFileSync(path.join(from, 'path.txt'), path.join(packageRoot, 'path.txt'));
  }
} else {
  const env = { ...process.env }; delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  const install = spawnSync(process.execPath, [path.join(packageRoot, 'install.js')], { cwd: root, env, stdio: 'inherit', timeout: 300_000 });
  if (install.status !== 0 || install.error) throw Error(`Electron runtime setup failed: ${install.error?.message ?? install.status}`);
}
if (!fs.existsSync(path.join(packageRoot, 'path.txt'))) throw Error('Electron setup did not produce a launchable runtime.');
console.log(`Electron ${version} ready (${registerOnly ? 'existing runtime retained' : offline ? 'matching local distribution reused' : 'pinned distribution installed'}).`);

if ((args.includes('--register') || registerOnly) && process.platform === 'linux') {
  const launcher = path.join(root, '../bin/yunuspi');
  if (!fs.existsSync(launcher)) throw Error('Register the desktop entry only from an installed runtime.');
  const applicationRoot = path.join(os.homedir(), '.local/share/applications');
  fs.mkdirSync(applicationRoot, { recursive: true });
  const escape = value => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$').replace(/%/g, '%%');
  fs.writeFileSync(path.join(applicationRoot, 'yunuspi.desktop'), `[Desktop Entry]\nType=Application\nName=YunusPi\nComment=Your coding workspace, with a little more instinct\nExec="${escape(launcher)}" --gui\nIcon=${path.join(root, 'desktop/renderer/assets/rat.svg')}\nTerminal=false\nCategories=Development;\nStartupWMClass=YunusPi\nKeywords=AI;Code;Agent;\n`, { mode: 0o644 });
  console.log('Registered YunusPi in the Linux application launcher.');
}
