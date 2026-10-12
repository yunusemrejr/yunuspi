import fs from 'node:fs';
import path from 'node:path';

const PROBE_FLAGS = new Set(['--version', '-v', '--help', '-h']);

/** Direct CLI or desktop entrypoints do not necessarily hold the launcher's
 * flock. Keep this check shared by updates and installed-source verification. */
export function activePiProcesses(core) {
  if (process.platform !== 'linux') throw Error('Cannot attest idle YunusPi processes on this platform');
  const canonicalCore = fs.realpathSync(core);
  const belongs = file => file === canonicalCore || file.startsWith(canonicalCore + path.sep);
  const desktop = path.resolve(canonicalCore, '../../desktop');
  // Only the owned runtime layout has a sibling desktop. Avoid treating an
  // unrelated desktop directory as part of a standalone core fixture/install.
  const desktopEntries = path.basename(canonicalCore) === 'coding-agent' && path.basename(path.dirname(canonicalCore)) === 'core'
    && fs.existsSync(desktop) ? new Set(['main.mjs', 'launch.mjs'].map(name => path.join(fs.realpathSync(desktop), name))) : new Set();
  const electronFile = path.resolve(canonicalCore, '../../node_modules/electron/dist/electron');
  const electron = desktopEntries.size && fs.existsSync(electronFile) && fs.lstatSync(electronFile).isFile()
    ? fs.realpathSync(electronFile) : undefined;
  const found = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      // Electron can flatten its entire command line into argv[0]. Its exact
      // installed executable still owns this runtime if the CLI parent dies.
      // Include its helpers too: they may still use this distribution's files.
      if (electron && fs.readlinkSync(`/proc/${entry}/exe`).replace(/ \(deleted\)$/, '') === electron) {
        found.push(Number(entry)); continue;
      }
      const args = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean);
      const applicationArg = args.findIndex((arg, index) => index > 0 && !arg.startsWith('-'));
      const desktopArg = args.slice(1, applicationArg).some(arg => /^(?:-[epc]|--(?:eval|print|check))(?:=|$)/.test(arg)) ? -1 : applicationArg;
      let cwd, desktopEntry = false;
      const coreArg = args.findIndex((arg, index) => {
        if (!arg || arg.startsWith('-') || arg.includes('\n') || arg.includes('\r')) return false;
        try {
          cwd ??= fs.realpathSync(`/proc/${entry}/cwd`);
          const file = path.resolve(cwd, arg);
          if (belongs(file)) return true;
          if (index === desktopArg && desktopEntries.has(file)) { desktopEntry = true; return true; }
          const canonical = fs.realpathSync(file);
          if (belongs(canonical)) return true;
          if (index === desktopArg && desktopEntries.has(canonical)) { desktopEntry = true; return true; }
          return false;
        } catch (error) {
          if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM', 'ENOTDIR', 'EINVAL', 'ENAMETOOLONG'].includes(error.code)) return false;
          throw error;
        }
      });
      // A bare version or help probe holds no session; a polling `yunuspi --version` must not block an update forever.
      const probe = !desktopEntry && coreArg >= 0 && args.length === coreArg + 2 && PROBE_FLAGS.has(args[coreArg + 1]);
      if (coreArg >= 0 && !probe) found.push(Number(entry));
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }
  return found;
}
