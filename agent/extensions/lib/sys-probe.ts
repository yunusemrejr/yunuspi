/**
 * sys_probe parsers — pure text → structured rows for ss/systemctl/ps.
 * The tool wrapper (extensions/sys-probe.ts) owns subprocess execution.
 */

export type Listener = { proto: string; local: string; process?: string };
export type ServiceRow = { unit: string; load: string; active: string; sub: string; description: string };
export type ProcessRow = { pid: number; ppid: number; cpu: number; mem: number; command: string };

/** Parse `ss -tulpn` / `ss -tulpnH` listener lines. */
export function parseSsListeners(output: string, limit = 100): Listener[] {
  const rows: Listener[] = [];
  for (const line of output.split("\n")) {
    const text = line.trim();
    if (!text || /^(?:Netid|State)\s/i.test(text)) continue;
    const tokens = text.split(/\s+/);
    if (tokens.length < 6) continue;
    const proto = tokens[0];
    if (!/^(?:tcp|udp|tcp6|udp6)$/.test(proto)) continue;
    const local = tokens[4];
    if (!local || !local.includes(":")) continue;
    const processMatch = /users:\(\("([^"]+)",pid=(\d+)/.exec(text);
    const process = processMatch ? `${processMatch[1]} (pid ${processMatch[2]})` : undefined;
    rows.push({ proto, local, ...(process ? { process } : {}) });
    if (rows.length >= limit) break;
  }
  return rows;
}

/** Parse `systemctl list-units --type=service ... --no-legend` lines. */
export function parseServiceList(output: string, limit = 100): ServiceRow[] {
  const rows: ServiceRow[] = [];
  for (const line of output.split("\n")) {
    const text = line.replace(/^[●*]\s*/, "").trim();
    if (!text || /^(?:UNIT|LOAD|ACTIVE)\s/i.test(text)) continue;
    const tokens = text.split(/\s+/);
    if (tokens.length < 4 || !tokens[0].includes(".")) continue;
    const [unit, load, active, sub, ...rest] = tokens;
    rows.push({ unit, load, active, sub, description: rest.join(" ").slice(0, 160) });
    if (rows.length >= limit) break;
  }
  return rows;
}

/** Parse `ps -eo pid=,ppid=,pcpu=,pmem=,comm= --sort=-pcpu` lines. */
export function parsePsTop(output: string, limit = 30): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split("\n")) {
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 5) continue;
    const [pid, ppid, cpu, mem, ...rest] = tokens;
    if (!/^\d+$/.test(pid) || !/^\d+$/.test(ppid)) continue;
    rows.push({ pid: Number(pid), ppid: Number(ppid), cpu: Number(cpu), mem: Number(mem), command: rest.join(" ").slice(0, 160) });
    if (rows.length >= limit) break;
  }
  return rows;
}
