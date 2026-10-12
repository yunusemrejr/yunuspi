#!/usr/bin/env node
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Chromium needs a working sandbox: either the setuid chrome-sandbox helper
 * (root-owned, mode 4755) or unprivileged user namespaces. Home-directory
 * installs cannot chown the helper without sudo, and Ubuntu 24.04+ AppArmor
 * (`kernel.apparmor_restrict_unprivileged_userns=1`) blocks the namespace
 * fallback — Electron then aborts with a FATAL sandbox error before any
 * window appears (the dock icon "does nothing"). Detect that exact case and
 * degrade to --no-sandbox for this launch only, with a warning; if the
 * helper is fixed system-wide later, the real sandbox returns automatically.
 * Renderer isolation (contextIsolation + webPreferences sandbox) is separate
 * and stays on. YUNUSPI_ELECTRON_SANDBOX=on forces the sandbox, =off forces
 * the fallback.
 */
export function electronSandboxArgs(electronPath) {
  if (process.platform !== 'linux') return [];
  const forced = process.env.YUNUSPI_ELECTRON_SANDBOX;
  if (forced === 'off') return ['--no-sandbox'];
  if (forced === 'on') return [];
  let setuidRoot = false;
  try {
    const stat = fs.statSync(path.join(path.dirname(electronPath), 'chrome-sandbox'));
    setuidRoot = stat.uid === 0 && (stat.mode & 0o7777) === 0o4755;
  } catch { /* no helper: only the namespace sandbox could work */ }
  if (setuidRoot) return [];
  let usernsRestricted = false;
  try { usernsRestricted = fs.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim() === '1'; }
  catch { /* sysctl unreadable: assume namespaces usable */ }
  if (!usernsRestricted) return [];
  console.error('YunusPi: Chromium sandbox unavailable (helper is not setuid-root and user namespaces are restricted); launching with --no-sandbox. To restore the sandbox: sudo chown root:root <electron-dist>/chrome-sandbox && sudo chmod 4755 <electron-dist>/chrome-sandbox');
  return ['--no-sandbox'];
}

export function launchDesktop(args = []) {
  const require = createRequire(import.meta.url);
  let electron;
  try { electron = require('electron'); }
  catch { throw Error('Electron is not installed. Run npm ci --ignore-scripts, then node node_modules/electron/install.js in the YunusPi runtime.'); }
  if (typeof electron !== 'string' || !fs.existsSync(electron)) throw Error('The Electron runtime is missing. Run node node_modules/electron/install.js in the YunusPi runtime.');
  const env = { ...process.env, YUNUSPI_NODE_BINARY: process.execPath, YUNUSPI_OPEN_PROJECT: process.cwd(), YUNUSPI_INITIAL_PROMPT: args.join(' ') };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [...electronSandboxArgs(electron), path.join(path.dirname(fileURLToPath(import.meta.url)), 'main.mjs'), ...args], { stdio: 'inherit', env });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  const forward = signal => child.kill(signal);
  process.once('SIGTERM', forward); process.once('SIGINT', forward);
  child.once('exit', () => { process.removeListener('SIGTERM', forward); process.removeListener('SIGINT', forward); });
  return child;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) launchDesktop(process.argv.slice(2));
