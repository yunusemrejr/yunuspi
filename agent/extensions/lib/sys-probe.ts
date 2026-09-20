/**
 * sys_probe parsers — pure text → structured rows for ss/systemctl/ps.
 * The tool wrapper (extensions/sys-probe.ts) owns subprocess execution.
 */

export type Listener = { proto: string; local: string; process?: string };
export type ServiceRow = { unit: string; load: string; active: string; sub: string; description: string };
export type ProcessRow = { pid: number; ppid: number; cpu: number; mem: number; command: string };

/** Presence only: never expose SSH addresses, display/socket names or env values. */
export function sessionDependencySignals(env: NodeJS.ProcessEnv = process.env) {
  const present = (...keys: string[]) => keys.some((key) => Boolean(env[key]));
  return {
    ssh: present("SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"),
    graphical: present("DISPLAY", "WAYLAND_DISPLAY"),
    multiplexedTerminal: present("TMUX", "STY"),
    wsl: present("WSL_INTEROP", "WSL_DISTRO_NAME"),
    ci: present("CI", "GITHUB_ACTIONS", "GITLAB_CI"),
    connectivityRequired: "unknown",
    scope: "inherited environment indicators; absence does not prove local control",
  };
}

export function deviceKind(name: string): string | null {
  if (/^tty(?:USB|ACM|AMA|S)\d+$/.test(name)) return "serial";
  if (/^gpiochip\d+$/.test(name)) return "gpio";
  if (/^i2c-\d+$/.test(name)) return "i2c";
  if (/^spidev\d+\.\d+$/.test(name)) return "spi";
  if (/^dri\/(?:card|renderD)\d+$/.test(name)) return "gpu";
  return null;
}

/** Routing-table input stays local; only interface names leave this parser. */
export function defaultRouteInterfaces(text: string | null, ipv6 = false): string[] | null {
  if (text === null || text.length > 4096) return null;
  const names = new Set<string>();
  let header = false, records = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/);
    if (!ipv6 && fields.join(' ') === 'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT') { header = true; continue; }
    records++;
    if (ipv6) {
      if (fields.length !== 10 || ![0,2,4].every(i => /^[a-f\d]{32}$/i.test(fields[i])) ||
        ![1,3].every(i => /^[a-f\d]{2}$/i.test(fields[i]) && parseInt(fields[i],16) <= 128) ||
        ![5,6,7,8].every(i => /^[a-f\d]{8}$/i.test(fields[i])) || !/^[\w.:-]{1,64}$/.test(fields[9])) return null;
      if (/^0{32}$/.test(fields[0]) && fields[1] === "00" && (parseInt(fields[8], 16) & 1) && !(parseInt(fields[8], 16) & 0x200)) names.add(fields[9]);
    } else {
      if (fields.length !== 11 || !/^[\w.:-]{1,64}$/.test(fields[0]) ||
        ![1,2,7].every(i => /^[a-f\d]{8}$/i.test(fields[i])) || !/^[a-f\d]{1,8}$/i.test(fields[3]) ||
        ![4,5,6,8,9,10].every(i => /^\d+$/.test(fields[i]))) return null;
      if (fields[1] === "00000000" && fields[7] === "00000000" && (parseInt(fields[3], 16) & 1) && !(parseInt(fields[3], 16) & 0x200)) names.add(fields[0]);
    }
  }
  if (!ipv6 && !header && !records) return null;
  if (names.size > 32) return null;
  return [...names];
}

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
