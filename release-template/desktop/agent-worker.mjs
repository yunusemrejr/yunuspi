import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';

// LF framing preserves U+2028/U+2029 inside JSON. Chunk lists make fragmented
// image/results linear in size, and the byte bound prevents unbounded retention.
export function jsonLines(onValue, onError, limit = 32 * 1024 * 1024) {
  const decoder = new StringDecoder('utf8');
  let chunks = [], bytes = 0, failed = false;
  const append = part => {
    bytes += Buffer.byteLength(part);
    if (bytes > limit) throw Error('Agent output exceeded the 32 MiB record limit.');
    if (part) chunks.push(part);
  };
  return chunk => {
    if (failed) return;
    try {
      const text = decoder.write(chunk);
      let start = 0, end;
      while ((end = text.indexOf('\n', start)) !== -1) {
        append(text.slice(start, end));
        const line = chunks.join('');
        chunks = []; bytes = 0; start = end + 1;
        if (line.trim()) onValue(JSON.parse(line));
      }
      append(text.slice(start));
    } catch (error) {
      failed = true;
      chunks = []; bytes = 0;
      onError(error);
    }
  };
}

export class AgentWorker extends EventEmitter {
  constructor({ command, args, cwd, env, timeout = 60_000, spawnProcess = spawn }) {
    super();
    this.pending = new Map();
    this.timeout = timeout;
    this.busy = false;
    this.dead = false;
    this.stopping = false;
    this.sequence = 0;
    this.stderr = '';
    this.child = spawnProcess(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdin.on('error', error => this.fatal(error));
    this.child.stdout.on('error', error => this.fatal(error));
    this.child.stdout.on('data', jsonLines(value => this.receive(value), error => this.fatal(error)));
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk.toString()).slice(-6000); });
    this.child.stderr.on('error', error => this.fatal(error));
    this.exited = new Promise(resolve => {
      this.child.once('error', error => this.fatal(error));
      const finish = (code, signal) => {
        if (this.dead) return;
        clearTimeout(this.drainTimer);
        this.dead = true;
        this.busy = false;
        const expected = this.stopping && !this.failure;
        const message = this.failure?.message || this.stderr.trim() || (expected ? 'Session closed.' : `Agent stopped (${signal ?? code}).`);
        this.fail(this.failure || Error(message));
        try { this.emit('stopped', { code, signal, expected, message: message.slice(-2000) }); }
        finally { resolve(); }
      };
      this.child.once('close', finish);
      this.child.once('exit', (code, signal) => {
        this.exitResult = { code, signal };
        this.busy = false;
        // Descendants can retain stdout after the agent has exited. Give its
        // buffered final records a short drain, then release our pipe handles;
        // the owned core/reaper remains responsible for descendant cleanup.
        this.drainTimer = setTimeout(() => {
          this.child.stdin.destroy(); this.child.stdout.destroy(); this.child.stderr.destroy();
          finish(code, signal);
        }, 200);
      });
    });
  }
  fatal(error) {
    // A protocol/pipe failure cannot recover on this connection. Use the same
    // bounded cleanup as a close, while retaining an unexpected failure reason.
    if (this.dead || this.stopping || this.failure) return;
    this.failure = error instanceof Error ? error : Error(String(error));
    this.busy = false;
    this.fail(this.failure);
    void this.stop();
  }
  fail(error) {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
    this.pending.clear();
  }
  receive(event) {
    if (this.dead || this.failure) return;
    if (!event || typeof event.type !== 'string') return;
    if (event.type === 'response') {
      const pending = this.pending.get(event.id);
      if (pending) {
        this.pending.delete(event.id); clearTimeout(pending.timer);
        if (event.success) pending.resolve(pending.withBoundary ? { data: event.data, sequence: this.sequence, busy: this.busy } : event.data);
        else pending.reject(Error(event.error || 'Agent command failed.'));
      }
      return;
    }
    if (event.type === 'agent_start') this.busy = true;
    if (event.type === 'agent_end') this.busy = false;
    this.emit('event', event, ++this.sequence);
  }
  write(value) {
    if (this.failure) throw this.failure;
    if (this.dead || this.stopping || this.exitResult || !this.child.stdin.writable) throw Error('Session is not connected.');
    if (this.child.stdin.writableLength > 4 * 1024 * 1024) throw Error('Agent is catching up. Try again shortly.');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  request(type, values = {}, timeout = this.timeout) {
    return this.sendRequest(type, values, timeout, false);
  }
  requestWithBoundary(type, values = {}, timeout = this.timeout) {
    return this.sendRequest(type, values, timeout, true);
  }
  sendRequest(type, values, timeout, withBoundary) {
    if (this.pending.size >= 64) return Promise.reject(Error('Too many pending agent commands.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`${type} timed out. The task may still be running; check the session before retrying.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, withBoundary });
      try { this.write({ ...values, type, id }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async stop() {
    if (this.dead) return;
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      // EOF uses the core's native shutdown: abort, release tools and flush memory.
      this.child.stdin.end();
      const term = setTimeout(() => this.child.kill('SIGTERM'), 7000);
      const kill = setTimeout(() => this.child.kill('SIGKILL'), 12_000);
      try { await this.exited; } finally { clearTimeout(term); clearTimeout(kill); }
    })();
    return this.stopPromise;
  }
}
