import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
/** Owns exactly one MCP process for a harness session, with bounded restart. */
export class UtilityClient {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private stopped = false;
  private restart?: ReturnType<typeof setTimeout>;
  private restartTimes: number[] = [];
  readonly root: string;
  constructor(root: string) { this.root = fs.realpathSync(root); }

  async start(): Promise<void> {
    if (this.stopped) throw Error('Utility session is closed');
    if (this.starting) return this.starting;
    if (this.child) return;
    this.starting = this.connect();
    try { await this.starting; } finally { this.starting = undefined; }
  }
  private async connect() {
    clearTimeout(this.restart);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./utility-mcp/server.mjs', import.meta.url)), '--workspace', this.root], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 512 * 1024) { child.kill('SIGKILL'); return; }
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        try {
          const msg = JSON.parse(line), job = this.pending.get(msg.id);
          if (!job) continue;
          this.pending.delete(msg.id); clearTimeout(job.timer);
          if (msg.error) job.reject(Error('Utility MCP protocol error'));
          else job.resolve(msg.result);
        } catch { child.kill('SIGKILL'); }
      }
    });
    child.stderr.resume(); // No source snippets, secrets or unbounded stderr retention.
    child.stdin.on('error', () => {});
    child.once('error', () => this.disconnected(child));
    child.once('exit', () => this.disconnected(child));
    try {
      const initialized = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'yunuspi', version: '1.0.0' } }, 4000);
      if (initialized?.serverInfo?.name !== 'yunuspi-utility-mcp') throw Error('Unexpected utility server');
      this.notify('notifications/initialized', {});
      const catalog = await this.request('tools/list', {}, 2000);
      if (catalog?.tools?.length !== 8) throw Error('Incomplete utility catalog');
    } catch (error) { child.kill('SIGKILL'); throw error; }
  }
  private disconnected(child: ChildProcessWithoutNullStreams) {
    if (this.child !== child) return;
    this.child = undefined;
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(Error('Utility process stopped; it will restart automatically')); }
    this.pending.clear();
    if (this.stopped) return;
    this.restartTimes = this.restartTimes.filter(t => Date.now() - t < 60000);
    if (this.restartTimes.length >= 3) return; // No crash loop; next call can retry.
    this.restartTimes.push(Date.now());
    this.restart = setTimeout(() => { void this.start().catch(() => {}); }, 250 * 2 ** this.restartTimes.length);
    this.restart.unref();
  }
  private notify(method: string, params: unknown) { this.child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
  private request(method: string, params: unknown, timeout: number, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) return Promise.reject(Error('Utility request cancelled'));
    if (!this.child || this.pending.size >= 16) return Promise.reject(Error('Utility unavailable or busy'));
    const id = ++this.sequence;
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    if (Buffer.byteLength(line) > 512 * 1024) return Promise.reject(Error('Utility request byte limit exceeded'));
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const pending = this.pending.get(id); if (!pending) return;
        this.pending.delete(id); clearTimeout(pending.timer); this.notify('notifications/cancelled', { requestId: id });
        signal?.removeEventListener('abort', cancel); reject(Error('Utility request cancelled'));
      };
      const cleanup = () => signal?.removeEventListener('abort', cancel);
      const timer = setTimeout(() => {
        this.pending.delete(id); cleanup(); this.notify('notifications/cancelled', { requestId: id });
        // A stuck protocol owner is replaced; the next call performs a fresh handshake.
        this.child?.kill('SIGKILL'); reject(Error('Utility request deadline exceeded'));
      }, timeout);
      this.pending.set(id, { timer, resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } });
      signal?.addEventListener('abort', cancel, { once: true });
      this.child!.stdin.write(line);
    });
  }
  async call(name: string, args: unknown, signal?: AbortSignal) {
    await this.start();
    return this.request('tools/call', { name, arguments: args }, 7500, signal);
  }
  close() {
    this.stopped = true; clearTimeout(this.restart);
    const child = this.child;
    if (child) {
      child.stdin.end(); child.kill('SIGTERM');
      const force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 500);
      force.unref();
      this.disconnected(child);
    }
  }
}
