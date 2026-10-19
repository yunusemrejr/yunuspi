import { parentPort, workerData } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bounded } from './files.mjs';

const { root, name, args } = workerData;
try {
  let result;
  if (['sqlite_probe', 'workspace_search'].includes(name)) {
    result = await new Promise((resolve, reject) => {
      const process = execFile('python3', ['-I', fileURLToPath(new URL('./probe.py', import.meta.url))], { timeout: 5200, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(Error('Inspection process failed or exceeded limits'));
        try { resolve(JSON.parse(stdout)); } catch { reject(Error('Invalid inspection response')); }
      });
      process.stdin.on('error', () => {});
      process.stdin.end(JSON.stringify({ root, name, args }));
    });
    if (result.error) throw Error(result.error);
  }
  parentPort.postMessage({ content: [{ type: 'text', text: bounded(result) }], isError: false });
} catch (error) {
  // Subprocess stderr and parse errors can contain document values. Never pass
  // them through, and never retain source data between requests.
  const message = error?.stderr || error?.stdout ? 'Inspection failed (subprocess error)' : String(error?.message ?? 'Inspection failed').slice(0, 240);
  parentPort.postMessage({ content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true });
}
