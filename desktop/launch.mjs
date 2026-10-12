#!/usr/bin/env node
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function launchDesktop(args = []) {
  const require = createRequire(import.meta.url);
  let electron;
  try { electron = require('electron'); }
  catch { throw Error('Electron is not installed. Run npm ci --ignore-scripts, then node node_modules/electron/install.js in the YunusPi runtime.'); }
  if (typeof electron !== 'string' || !fs.existsSync(electron)) throw Error('The Electron runtime is missing. Run node node_modules/electron/install.js in the YunusPi runtime.');
  const env = { ...process.env, YUNUSPI_NODE_BINARY: process.execPath, YUNUSPI_OPEN_PROJECT: process.cwd(), YUNUSPI_INITIAL_PROMPT: args.join(' ') };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.mjs'), ...args], { stdio: 'inherit', env });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  const forward = signal => child.kill(signal);
  process.once('SIGTERM', forward); process.once('SIGINT', forward);
  child.once('exit', () => { process.removeListener('SIGTERM', forward); process.removeListener('SIGINT', forward); });
  return child;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) launchDesktop(process.argv.slice(2));
