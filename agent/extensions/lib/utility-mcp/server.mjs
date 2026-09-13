#!/usr/bin/env node
// One local MCP stdio server; bounded disposable workers keep CPU-heavy parsing
// from blocking framing, cancellation, deadlines or lifecycle notifications.
import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { TOOLS, validate } from './catalog.mjs';

const rootIndex = process.argv.indexOf('--workspace');
if (rootIndex < 0 || !process.argv[rootIndex + 1]) throw Error('--workspace is required');
const root = fs.realpathSync(process.argv[rootIndex + 1]);
if (!fs.statSync(root).isDirectory()) throw Error('Workspace must be a directory');
const PROTOCOL = '2025-06-18', INPUT_CAP = 512 * 1024, jobs = new Map();
let initialized = false, ready = false, input = Buffer.alloc(0), shuttingDown = false;
const send = message => {
  if (process.stdout.writableLength > 1024 * 1024) { shutdown(); return; }
  if (!shuttingDown) process.stdout.write(JSON.stringify(message) + '\n');
};
const result = (id, value) => send({ jsonrpc: '2.0', id, result: value });
const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const failure = message => ({ content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true });

function stopJob(id, message, worker) {
  const job = jobs.get(id); if (!job || worker && job.worker !== worker) return;
  clearTimeout(job.timer); jobs.delete(id); void job.worker.terminate();
  result(id, failure(message));
}
function dispatch(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' || request.id !== undefined && typeof request.id !== 'number' && typeof request.id !== 'string') return error(null, -32600, 'Invalid request');
  const { id, method, params = {} } = request;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    if (id !== undefined) error(id, -32602, 'Params must be an object');
    return;
  }
  if (id === undefined) {
    if (method === 'notifications/initialized' && initialized) ready = true;
    if (method === 'notifications/cancelled') stopJob(params.requestId, 'Request cancelled');
    return;
  }
  if (jobs.has(id)) return error(id, -32600, 'Duplicate active request ID');
  if (method === 'initialize') {
    if (initialized) return error(id, -32600, 'Already initialized');
    initialized = true;
    return result(id, { protocolVersion: ['2024-11-05', '2025-03-26', PROTOCOL].includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL,
      capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'yunuspi-utility-mcp', version: '1.0.0' },
      instructions: 'Use these bounded specialized tools instead of shell inspection snippets. Files are confined to the startup workspace. Supply explicit paths; no recursive discovery. Read output_truncated/truncated before drawing conclusions.' });
  }
  if (method === 'ping') return result(id, {});
  if (!ready) return error(id, -32000, 'Initialization required');
  if (method === 'tools/list') return result(id, { tools: TOOLS });
  if (method !== 'tools/call') return error(id, -32601, 'Method not found');
  let args;
  try { args = validate(params.name, params.arguments ?? {}); }
  catch (e) { return result(id, failure(e.message)); }
  if (jobs.size >= 2) return result(id, failure('Utility concurrency limit reached; retry after an active call completes'));
  const worker = new Worker(new URL('./worker.mjs', import.meta.url), { workerData: { root, name: params.name, args }, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }, stdout: true, stderr: true });
  // Worker dependencies and inspection backends must never contaminate MCP stdout.
  worker.stdout.resume(); worker.stderr.resume();
  const timer = setTimeout(() => stopJob(id, 'Utility exceeded the 6 second runtime limit', worker), 6000);
  jobs.set(id, { worker, timer });
  worker.once('message', value => {
    if (jobs.get(id)?.worker !== worker) return;
    clearTimeout(timer); jobs.delete(id); void worker.terminate(); result(id, value);
  });
  worker.once('error', () => stopJob(id, 'Utility worker failed or exceeded memory limits', worker));
  worker.once('exit', () => stopJob(id, 'Utility worker exited without a result', worker));
}
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { worker, timer } of jobs.values()) { clearTimeout(timer); void worker.terminate(); }
  jobs.clear(); process.stdin.destroy();
}
process.stdin.on('data', chunk => {
  input = Buffer.concat([input, chunk]);
  let newline;
  while ((newline = input.indexOf(10)) !== -1) {
    if (newline > INPUT_CAP) { error(null, -32600, 'Request byte limit exceeded'); shutdown(); return; }
    const line = input.subarray(0, newline); input = input.subarray(newline + 1);
    if (!line.length) continue;
    try { dispatch(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))); }
    catch { error(null, -32700, 'Parse error'); }
  }
  if (input.length > INPUT_CAP) { error(null, -32600, 'Request byte limit exceeded'); shutdown(); }
});
process.stdin.on('end', shutdown);
process.stdin.on('error', shutdown);
process.stdout.on('error', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
