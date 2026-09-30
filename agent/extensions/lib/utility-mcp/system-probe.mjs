import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const unitPattern = /^(?:[A-Za-z0-9_.:@-]|\\x[0-9a-fA-F]{2}){1,200}\.(?:service|socket|timer|target|mount|automount|path|scope|slice)$/;
const rounded = value => Math.round(value * 100) / 100;
export function inspectionFailure(error) {
  const code = error?.inspectionCode ?? error?.code;
  if (['EACCES', 'EPERM', 'permission_denied'].includes(code)) return 'permission_denied';
  if (['ENOENT', 'ENOTDIR', 'unavailable'].includes(code)) return 'unavailable';
  if (['ABORT_ERR', 'cancelled'].includes(code) || error?.name === 'AbortError') return 'cancelled';
  if (error?.name === 'TimeoutError' || ['limit', 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(code) || error?.killed) return 'limit';
  if (code === 'manager_unavailable') return 'manager_unavailable';
  return 'inspection_failed';
}
async function readMetadata(file, signal) {
  signal?.throwIfAborted();
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) throw Object.assign(Error('not metadata'), { inspectionCode: 'unavailable' });
    const data = Buffer.alloc(16385);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    signal?.throwIfAborted();
    if (bytesRead > 16384) throw Object.assign(Error('metadata limit'), { inspectionCode: 'limit' });
    return { status: 'ok', text: data.subarray(0, bytesRead).toString('utf8') };
  } catch (error) { return { status: inspectionFailure(signal?.aborted ? signal.reason : error) }; }
  finally { await handle?.close(); }
}
async function nativeRun(binary, args, signal) {
  const result = await execute(binary, args, { signal, timeout: 2000, maxBuffer: 65536, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' } });
  return result.stdout;
}
function numberLine(text, name) {
  const found = text?.match(new RegExp(`^${name}:\\s+(\\d+)(?: kB)?$`, 'm'))?.[1];
  return found && Number.isSafeInteger(Number(found)) ? Number(found) : null;
}
function pressure(text) {
  const row = text?.match(/^some avg10=(\d+\.\d+) avg60=(\d+\.\d+) avg300=(\d+\.\d+) total=\d+$/m);
  return row ? { avg10: Number(row[1]), avg60: Number(row[2]), avg300: Number(row[3]) } : null;
}
async function resources(read, platform) {
  const [memory, cpu, ram, io, membership] = await Promise.all(['proc/meminfo', 'proc/pressure/cpu', 'proc/pressure/memory', 'proc/pressure/io', 'proc/self/cgroup'].map(read));
  const relative = membership.text?.match(/^0::(\/.*)$/m)?.[1];
  let cgroup = { status: membership.status === 'ok' ? 'unavailable' : membership.status, scope: 'Current unified cgroup only; v1 and unmapped/container paths are unknown.' };
  if (relative && relative.length <= 1024 && relative.split('/').every(part => part !== '..' && part !== '.' && /^[A-Za-z0-9_.:@-]*$/.test(part))) {
    const prefix = 'sys/fs/cgroup' + (relative === '/' ? '' : relative);
    const raw = await Promise.all(['memory.max', 'memory.current', 'cpu.max', 'pids.max', 'pids.current'].map(name => read(prefix + '/' + name)));
    const scalar = value => value?.trim() === 'max' ? 'max' : /^\d{1,16}\s*$/.test(value ?? '') && Number.isSafeInteger(Number(value)) ? Number(value) : null;
    const cpuMax = raw[2].text?.trim().match(/^(max|\d{1,16}) (\d{1,16})$/);
    cgroup = { ...cgroup, status: raw.every(item => item.status === 'ok') ? 'ok' : 'partial', fields: raw.map((item, i) => ({ field: ['memory.max', 'memory.current', 'cpu.max', 'pids.max', 'pids.current'][i], status: item.status })), memory_max_bytes: scalar(raw[0].text), memory_current_bytes: scalar(raw[1].text), cpu_quota_cores: cpuMax && Number(cpuMax[2]) > 0 ? cpuMax[1] === 'max' ? 'max' : rounded(Number(cpuMax[1]) / Number(cpuMax[2])) : null, pids_max: scalar(raw[3].text), pids_current: scalar(raw[4].text) };
  }
  const total = numberLine(memory.text, 'MemTotal'), available = numberLine(memory.text, 'MemAvailable');
  const pressureFacts = Object.fromEntries([['cpu', cpu], ['memory', ram], ['io', io]].map(([name, value]) => [name, { status: value.status === 'ok' && pressure(value.text) === null ? 'invalid_metadata' : value.status, some_percent: pressure(value.text) }]));
  const memoryStatus = memory.status === 'ok' && (!total || available === null) ? 'invalid_metadata' : memory.status;
  return { status: memoryStatus === 'ok' && Object.values(pressureFacts).every(value => value.status === 'ok') && cgroup.status === 'ok' ? 'ok' : memoryStatus !== 'ok' ? memoryStatus : 'partial', platform, architecture: os.arch(), kernel: os.release(), cpu_parallelism: os.availableParallelism(), load_average: os.loadavg().map(rounded), memory: { status: memoryStatus, total_mib: total === null ? null : rounded(total / 1024), available_mib: available === null ? null : rounded(available / 1024), available_percent: total && available !== null ? rounded(100 * available / total) : null }, pressure: pressureFacts, cgroup, scope: 'Current process OS/namespace view; load is runnable plus uninterruptible work, not CPU utilization. No hostname, addresses, commands, environment or config values.' };
}
async function processFacts(pid, read) {
  const result = await read(`proc/${pid}/status`);
  if (result.status !== 'ok') return { status: result.status, pid, presence: 'unknown' };
  const state = result.text.match(/^State:\s+([RSDZTtXxIKPW])\b/m)?.[1] ?? null;
  return { status: state === null ? 'invalid_metadata' : 'ok', pid, parent_pid: numberLine(result.text, 'PPid'), state, threads: numberLine(result.text, 'Threads'), rss_mib: numberLine(result.text, 'VmRSS') === null ? null : rounded(numberLine(result.text, 'VmRSS') / 1024), scope: 'Instantaneous PID metadata only; PID reuse, process identity and ownership require separate verification.' };
}
async function portFacts(port, run, signal) {
  const text = await run('/usr/bin/ss', ['-ltnpH', 'sport', '=', ':' + port], signal);
  if (Buffer.byteLength(text) > 65536) throw Object.assign(Error('output limit'), { inspectionCode: 'limit' });
  const rows = [], lines = text.split('\n').filter(line => line.trim());
  for (const line of lines.slice(0, 32)) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] !== 'LISTEN' || fields.length < 5) continue;
    const local = fields[3], suffix = local.match(/:(\d+)$/);
    if (Number(suffix?.[1]) !== port) continue;
    const address = local.slice(0, -(suffix[0].length)).replace(/^\[|\]$/g, '');
    const bind = ['*', '0.0.0.0', '::'].includes(address) ? 'wildcard' : /^(?:127\.|::1$|::ffff:127\.)/.test(address) ? 'loopback' : 'non_loopback';
    rows.push({ bind, pids: [...new Set([...line.matchAll(/\bpid=(\d+)/g)].map(m => Number(m[1])))].slice(0, 8) });
  }
  return { status: lines.length && !rows.length ? 'invalid_metadata' : 'ok', port, protocol: 'tcp', listeners: rows, truncated: lines.length > 32, owner_visibility: !rows.length ? 'not_applicable' : rows.some(row => !row.pids.length) ? 'unknown' : 'visible', scope: 'Current network namespace TCP listeners only; no traffic sent. Missing owner metadata is unknown; UDP and remote availability are untested.' };
}

/** Bounded local diagnosis; dependencies are internal adapters, never tool inputs. */
export async function systemDiagnose(options = {}, signal, dependencies = {}) {
  signal?.throwIfAborted();
  if (options.pid !== undefined && (!Number.isSafeInteger(options.pid) || options.pid < 1 || options.pid > 2147483647)) throw Error('pid must be one positive PID');
  if (options.port !== undefined && (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535)) throw Error('port must be one TCP port');
  if (options.unit !== undefined && (typeof options.unit !== 'string' || !unitPattern.test(options.unit) || options.unit.startsWith('-'))) throw Error('Specify one exact systemd unit with suffix');
  if (options.user !== undefined && (typeof options.user !== 'boolean' || !options.unit)) throw Error('user applies only to an explicit unit');
  if (options.cursor !== undefined || options.lookbackSeconds !== undefined) throw Error('Journal options do not apply to diagnose');
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'linux') return { action: 'diagnose', rows: [], status: 'unavailable', reason: 'Linux metadata required', executed_changes: false };
  const deadline = AbortSignal.timeout(4500), boundedSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const started = performance.now();
  const read = relative => (dependencies.read ?? readMetadata)(path.join(dependencies.root ?? '/', relative), boundedSignal);
  const run = dependencies.run ?? nativeRun;
  const phase = async (name, operation) => {
    const start = performance.now();
    try { const facts = await operation(); return { phase: name, status: facts.status ?? 'ok', latency_ms: rounded(performance.now() - start), facts }; }
    catch (error) { return { phase: name, status: inspectionFailure(boundedSignal.aborted ? boundedSignal.reason : error), latency_ms: rounded(performance.now() - start) }; }
  };
  const jobs = [phase('resources', () => resources(read, platform))];
  if (options.pid !== undefined) jobs.push(phase('process', () => processFacts(options.pid, read)));
  if (options.port !== undefined) jobs.push(phase('port', () => portFacts(options.port, run, boundedSignal)));
  if (options.unit !== undefined) jobs.push(phase('service', async () => {
    if (!dependencies.service) return { status: 'unavailable', reason: 'Service metadata adapter unavailable' };
    const value = await dependencies.service({ unit: options.unit, user: options.user }, boundedSignal);
    return { status: 'ok', unit: options.unit, manager: options.user ? 'user' : 'system', ...value.rows[0] };
  }));
  const phases = await Promise.all(jobs), findings = [], recovery = [];
  const resource = phases[0].facts;
  if (resource?.memory.available_percent !== null && resource?.memory.available_percent < 5) { findings.push({ code: 'low_available_memory', evidence: 'resources.memory.available_percent', severity: 'warning' }); recovery.push('Identify the consuming workload and its cgroup budget before changing capacity or limits.'); }
  for (const item of phases) {
    if (item.status !== 'ok') { findings.push({ code: item.status, phase: item.phase, severity: 'unknown' }); continue; }
    if (item.phase === 'service' && item.facts.ActiveState === 'failed') { findings.push({ code: 'service_failed', evidence: 'service.ActiveState', severity: 'warning' }); recovery.push('Read bounded journal metadata for this exact unit and verify its dependencies before proposing a service change.'); }
    if (item.phase === 'port' && !item.facts.listeners.length) { findings.push({ code: 'no_visible_tcp_listener', evidence: 'port.listeners', severity: 'warning' }); recovery.push('Check the intended service and bind configuration in this network namespace; no listener does not establish remote or UDP state.'); }
    if (item.phase === 'process' && ['D', 'Z'].includes(item.facts.state)) { findings.push({ code: item.facts.state === 'D' ? 'process_uninterruptible_wait' : 'process_zombie', evidence: 'process.state', severity: 'warning' }); recovery.push('Verify the process parent and blocking dependency before any process intervention.'); }
  }
  return { action: 'diagnose', rows: phases, findings, proposed_recovery: { executed: false, steps: [...new Set(recovery)], constraints: 'Preserve the active session, connectivity and mounted data; exact target identity and recovery access are required before disruptive changes.' }, status: phases.every(item => item.status === 'ok') ? 'complete' : 'partial', latency_ms: rounded(performance.now() - started), executed_changes: false, cacheable: false, scope: 'Read-only local resource evidence plus explicitly requested PID, TCP port and unit. No enumeration, logs, credentials, network connections or mutations.' };
}
