#!/usr/bin/env node
// YunusPi updates are explicit installation of reviewed local YunusPi source.
// There is deliberately no registry lookup, remote ref resolution or self-update.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export { activePiProcesses } from './lib/active-core-processes.mjs';
export function updateInvocation(args, agent = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi/agent')) {
  let source, offline = false, skipNeedle = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source' && args[i + 1] && !args[i + 1].startsWith('--')) source = path.resolve(args[++i]);
    else if (args[i] === '--offline') offline = true;
    else if (args[i] === '--skip-needle') skipNeedle = true;
    else throw Error('Usage: yunuspi update --source /path/to/reviewed/yunuspi [--offline] [--skip-needle]');
  }
  if (!source) {
    if (args.length) throw Error('Usage: yunuspi update --source /path/to/reviewed/yunuspi [--offline] [--skip-needle]');
    return null;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'core/coding-agent/package.json'), 'utf8'));
  if (manifest.name !== '@yunuspi/coding-agent') throw Error('Update source must own @yunuspi/coding-agent');
  const installer = path.join(source, 'scripts/install.mjs');
  const stat = fs.lstatSync(installer);
  if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Update source needs a regular reviewed installer');
  return [installer, '--apply', '--backup-existing', '--preserve-state', '--target', path.resolve(agent), offline ? '--offline' : '--install-deps', ...(skipNeedle ? ['--skip-needle'] : [])];
}
function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help')) {
    console.log('YunusPi owns its core. No automatic core updates or upstream version checks are performed.\nReview a YunusPi release checkout, stop active sessions, then run:\n  yunuspi update --source /path/to/reviewed/yunuspi [--offline] [--skip-needle]\nPrivate state and compatible customizations carry forward. Source conflicts reject the update; the previous managed installation and configuration are preserved as a private backup.');
    return;
  }
  const invocation = updateInvocation(args);
  const result = spawnSync(process.execPath, invocation, {stdio: 'inherit'});
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
