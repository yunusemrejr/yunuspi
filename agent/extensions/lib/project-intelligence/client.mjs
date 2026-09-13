import { Worker } from "node:worker_threads";
/** One worker per active harness session; SQLite coordinates project peers.
 * Outstanding work is bounded; discovery never blocks the terminal event loop. */
export class IntelligenceClient {
  constructor({ cwd, stateDir, sessionId }) {
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    // Default stdio has Node's non-ref-counting forwarding. Custom worker stdio
    // refs its internal MessagePort even after worker.unref() on Node 22, keeping
    // disposed SDK sessions alive. This controlled worker never logs; suppress
    // only its runtime startup warnings and return actual failures via messages.
    this.worker = new Worker(new URL("./worker.mjs", import.meta.url), {
      workerData: { cwd, stateDir, sessionId },
      // This plain ESM worker needs no parent loaders or process-wide flags.
      // Forwarding process.execArgv can make Worker reject valid parent V8,
      // OpenSSL, test-runner or snapshot options before it starts.
      execArgv: ["--no-warnings"],
    });
    this.worker.on("message", (message) => {
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id);
      item.cleanup();
      message.error
        ? item.reject(
            Object.assign(Error(message.error.message), {
              code: message.error.code,
              currentVersion: message.error.currentVersion,
            }),
          )
        : item.resolve(message.result);
      if (!this.pending.size) this.worker.unref();
    });
    this.worker.on("error", (error) => this.fail(error));
    this.worker.on("exit", (code) => {
      if (!this.closed)
        this.fail(Error(`Project intelligence worker exited (${code})`));
    });
    this.ready = this.request("init", {}, { timeout: 10000 });
    this.ready.catch((error) => {
      this.fail(error);
      void this.worker.terminate();
    });
  }
  fail(error) {
    this.closed = true;
    for (const item of this.pending.values()) {
      item.cleanup();
      item.reject(error);
    }
    this.pending.clear();
  }
  request(op, payload = {}, { signal, timeout = 15000 } = {}) {
    if (this.closed)
      return Promise.reject(Error("Project intelligence worker is closed."));
    if (this.pending.size >= 64)
      return Promise.reject(Error("Project intelligence queue is full."));
    try {
      signal?.throwIfAborted();
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      let timer;
      const cancel = () => {
        try {
          this.worker.postMessage({ cancel: id });
        } catch {}
      };
      const abort = () => {
        const item = this.pending.get(id);
        if (!item) return;
        this.pending.delete(id);
        item.cleanup();
        cancel();
        reject(
          signal?.reason ?? Error("Project intelligence request cancelled"),
        );
        if (!this.pending.size) this.worker.unref();
      };
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        cancel();
        reject(Error("Project intelligence request timed out"));
        if (!this.pending.size) this.worker.unref();
      }, timeout);
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { resolve, reject, cleanup });
      this.worker.ref();
      try {
        this.worker.postMessage({ id, op, payload });
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(error);
        if (!this.pending.size) this.worker.unref();
      }
    });
  }
  async close() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      if (!this.closed)
        try {
          await this.request("close", {}, { timeout: 1500 });
        } catch {}
      this.fail(Error("Project session closed"));
      await this.worker.terminate();
    })();
    return this.closing;
  }
}
