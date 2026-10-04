import fs from 'node:fs';
import path from 'node:path';

const PROBE_FLAGS = new Set(['--version', '-v', '--help', '-h']);

/** Direct CLI entrypoints do not necessarily hold the launcher's flock. Keep
 * this secondary check shared by updates and installed-source verification. */
export function activePiProcesses(core) {
  if (process.platform !== 'linux') throw Error('Cannot attest idle YunusPi processes on this platform');
  const canonicalCore = fs.realpathSync(core);
  const belongs = file => file === canonicalCore || file.startsWith(canonicalCore + path.sep);
  const found = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const args = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean);
      let cwd;
      const coreArg = args.findIndex(arg => {
        if (!arg || arg.startsWith('-') || arg.includes('\n') || arg.includes('\r')) return false;
        try {
          cwd ??= fs.realpathSync(`/proc/${entry}/cwd`);
          const file = path.resolve(cwd, arg);
          return belongs(file) || belongs(fs.realpathSync(file));
        } catch (error) {
          if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM', 'ENOTDIR', 'EINVAL', 'ENAMETOOLONG'].includes(error.code)) return false;
          throw error;
        }
      });
      // A bare version or help probe holds no session; a polling `yunuspi --version` must not block an update forever.
      const probe = coreArg >= 0 && args.length === coreArg + 2 && PROBE_FLAGS.has(args[coreArg + 1]);
      if (coreArg >= 0 && !probe) found.push(Number(entry));
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }
  return found;
}
