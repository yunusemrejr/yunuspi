/**
 * sys_probe — structured Linux system inspection.
 *
 * Replaces parsing `ss` / `systemctl` / `ps` output in bash (small models
 * struggle with those column formats). Read-only subprocesses only; output is
 * structured JSON and bounded.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import {
  parsePsTop,
  parseServiceList,
  parseSsListeners,
  deviceKind,
  sessionDependencySignals,
  defaultRouteInterfaces,
  type Listener,
  type ProcessRow,
  type ServiceRow,
} from "./lib/sys-probe.ts";

const execFileP = promisify(execFile);
const COMMANDS = ["listeners", "services", "processes", "host", "devices"] as const;
const TOOLCHAINS = ["arduino-cli", "pio", "platformio", "esptool", "esptool.py", "idf.py", "openocd", "arm-none-eabi-gcc", "cmake", "ninja", "python3", "ssh", "rsync", "docker", "podman"];
type Facts = { action: string; rows: (Listener | ServiceRow | ProcessRow | Record<string, unknown>)[]; truncated?: boolean; guidance?: string[]; warnings?: string[] };

async function run(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  try {
    const result = await execFileP(command, args, {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
      signal,
      // These fixed Linux inspection commands must not execute project PATH
      // shims or inherited dynamic-loader hooks. Toolchain discovery below
      // still describes the user's PATH without executing its candidates.
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
    });
    return String(result.stdout ?? "");
  } catch (error: any) {
    signal?.throwIfAborted();
    if (error?.code === "ENOENT")
      throw new Error(
        `${command} is not installed; this action needs it on the system PATH`,
      );
    if (error?.killed || error?.signal)
      throw new Error(`${command} timed out after 5s`);
    // ss/systemctl exit non-zero in some containers but still print useful rows.
    const stdout = String(error?.stdout ?? "");
    if (stdout.trim()) return stdout;
    throw new Error(
      `${command} failed: ${
        String(error?.stderr ?? error?.message ?? "")
          .trim()
          .slice(0, 200) || "unknown error"
      }`,
    );
  }
}

// Bounded reads of fixed system metadata only, never a device or user config.
async function metadata(file: string, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted();
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) return null;
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) return null;
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch { return null; }
  finally { await handle?.close(); signal?.throwIfAborted(); }
}

/** Fixed sysfs/proc metadata, without addresses, identifiers or network traffic. */
export async function hostSafetyFacts(signal?: AbortSignal, root = "/") {
  const read = (name: string) => metadata(path.join(root, name), signal);
  let truncated = false;
  const names = async (directory: string, limit: number) => {
    signal?.throwIfAborted();
    const found: string[] = [];
    let visited = 0;
    try {
      const handle = await fs.opendir(path.join(root, directory));
      for await (const entry of handle) {
        signal?.throwIfAborted();
        if (++visited > limit) { truncated = true; break; }
        if (/^[\w.:-]{1,64}$/.test(entry.name)) found.push(entry.name);
        else truncated = true;
      }
      return found;
    } catch { signal?.throwIfAborted(); return null; }
  };
  const [networkNames, powerNames, ipv4, ipv6] = await Promise.all([
    names("sys/class/net", 32), names("sys/class/power_supply", 8),
    read("proc/net/route"), read("proc/net/ipv6_route"),
  ]);
  const defaultV4 = defaultRouteInterfaces(ipv4), defaultV6 = defaultRouteInterfaces(ipv6, true);
  const interfaces = [];
  for (const name of networkNames ?? []) {
    const state = (await read(`sys/class/net/${name}/operstate`))?.trim();
    const wireless = await fs.stat(path.join(root, `sys/class/net/${name}/wireless`)).then((s) => s.isDirectory(), () => false);
    interfaces.push({ name, state: state && /^(up|down|unknown|dormant|notpresent|lowerlayerdown|testing)$/.test(state) ? state : null, wireless, defaultV4: defaultV4?.includes(name) ?? null, defaultV6: defaultV6?.includes(name) ?? null });
  }
  const supplies = [];
  for (const name of powerNames ?? []) {
    const [type, online, capacity, status] = (await Promise.all(["type", "online", "capacity", "status"].map((field) => read(`sys/class/power_supply/${name}/${field}`)))).map((value) => value?.trim());
    supplies.push({ name, type: type && /^(Battery|Mains|USB|USB_C|USB_PD|UPS|Wireless)$/.test(type) ? type : null, online: online === "1" ? true : online === "0" ? false : null, capacityPercent: capacity && /^\d{1,3}$/.test(capacity) && Number(capacity) <= 100 ? Number(capacity) : null, status: status && /^(Unknown|Charging|Discharging|Not charging|Full)$/.test(status) ? status : null });
  }
  signal?.throwIfAborted();
  return {
    network: { interfaces, available: networkNames !== null, scope: "current process network namespace metadata only; VPNs, policy routing and actual control-channel dependence are not established" },
    power: { supplies, available: powerNames !== null, scope: "reported supply status; missing readings are unknown, not proof of safe power or thermal headroom" },
    truncated,
  };
}

async function hostFacts(signal?: AbortSignal): Promise<Facts> {
  const [memory, model, safety] = await Promise.all([
    metadata("/proc/meminfo", signal),
    metadata("/sys/firmware/devicetree/base/model", signal),
    hostSafetyFacts(signal),
  ]);
  const availableKiB = memory?.match(/^MemAvailable:\s+(\d+) kB$/m)?.[1];
  const directories = [...new Set((process.env.PATH ?? "").split(path.delimiter).filter(path.isAbsolute))].slice(0, 32);
  const available: string[] = [];
  for (const command of TOOLCHAINS) {
    signal?.throwIfAborted();
    for (const directory of directories) {
      try {
        const candidate = path.join(directory, command);
        if (!(await fs.stat(candidate)).isFile()) continue;
        await fs.access(candidate, constants.X_OK);
        available.push(command);
        break;
      } catch {}
    }
  }
  return {
    action: "host",
    rows: [{
      platform: process.platform,
      environmentScope: "current process view; containers, sandboxes and remote targets can differ from the controlling physical host",
      architecture: os.arch(),
      kernel: os.release(),
      cpuParallelism: os.availableParallelism(),
      memoryMiB: { total: Math.floor(os.totalmem() / 1048576), available: availableKiB ? Math.floor(Number(availableKiB) / 1024) : null },
      loadAverage: os.loadavg().map((n) => Math.round(n * 100) / 100),
      rootUser: process.getuid?.() === 0,
      session: sessionDependencySignals(),
      network: safety.network,
      power: safety.power,
      boardModel: model?.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 160) || null,
      toolchains: { available, checked: TOOLCHAINS, scope: "executable files on first 32 absolute PATH directories; not executed or version-verified" },
      resourceScope: "OS-reported RAM/load; cgroup/container quotas and GPU capacity are not measured. CPU parallelism is affinity-aware, not a workload budget.",
    }],
    truncated: safety.truncated,
    guidance: [
      "Treat this host as the active control surface. Preserve connectivity, session/parent processes and mounted data; inspect exact targets before disruptive tests, service changes or resource stress. Do not disable default-route/Wi-Fi interfaces or assume a battery reading permits a stress test.",
      "Toolchain presence does not establish board identity, firmware compatibility or permission to flash. Use project_report workspace evidence for deployment and build configuration.",
    ],
  };
}

/** Directory metadata and access checks only: no serial/GPIO/GPU handles or I/O. */
export async function deviceFacts(limit: number, signal?: AbortSignal, root = "/dev"): Promise<Facts> {
  const rows: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  let visited = 0, truncated = false;
  for (const relative of ["", "dri"]) {
    signal?.throwIfAborted();
    const directory = path.join(root, relative);
    try {
      if (!(await fs.lstat(directory)).isDirectory()) continue;
      const handle = await fs.opendir(directory);
      for await (const entry of handle) {
        signal?.throwIfAborted();
        if (++visited > 1024) { truncated = true; break; }
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        const kind = deviceKind(name);
        if (!kind || !entry.isCharacterDevice()) continue;
        if (rows.length >= limit) { truncated = true; break; }
        const file = path.join(directory, entry.name);
        const accessible = (mode: number) => fs.access(file, mode).then(() => true, () => false);
        const [readable, writable] = await Promise.all([accessible(constants.R_OK), accessible(constants.W_OK)]);
        rows.push({ kind, path: file, readable, writable, source: "character device metadata; identity and availability unverified" });
      }
    } catch (error: any) {
      signal?.throwIfAborted();
      if (error?.code !== "ENOENT") warnings.push(`${relative || "/dev"}: metadata unavailable`);
    }
    if (truncated) break;
  }
  return {
    action: "devices", rows, truncated, ...(warnings.length ? { warnings } : {}),
    guidance: [
      "Device paths and permissions are candidates only; no board was contacted, no port opened and no firmware inspected. Missing nodes do not prove hardware is absent.",
      "Before flash/erase/reset or GPIO/I2C/SPI writes, verify board/port, voltage/pins, firmware target, backup and recovery route. Opening a serial port can reset a board; separate compile-only validation from upload/monitor.",
      "GPU nodes do not verify WebGPU support or memory budget; measure the actual adapter and workload before scaling detail or parallelism.",
    ],
  };
}

export async function runSysProbe(
  action: string,
  limit: number,
  signal?: AbortSignal,
): Promise<Facts> {
  signal?.throwIfAborted();
  limit = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 200) : 100;
  if (action === "host") return hostFacts(signal);
  if (action === "devices") return deviceFacts(limit, signal);
  if (action === "listeners") {
    const output = await run("ss", ["-tulpnH"], signal).catch(() =>
      run("ss", ["-tulpn"], signal),
    );
    return { action, rows: parseSsListeners(output, limit) };
  }
  if (action === "services") {
    const output = await run("systemctl", [
      "list-units",
      "--type=service",
      "--state=running",
      "--no-pager",
      "--no-legend",
    ], signal);
    return { action, rows: parseServiceList(output, limit) };
  }
  if (action === "processes") {
    const output = await run("ps", [
      "-eo",
      "pid=,ppid=,pcpu=,pmem=,comm=",
      "--sort=-pcpu",
    ], signal);
    return { action, rows: parsePsTop(output, limit) };
  }
  throw new Error(
    `Unsupported sys_probe action: ${String(action)} (allowed: ${COMMANDS.join(", ")})`,
  );
}

export default function sysProbe(pi: any) {
  pi.registerTool({
    name: "sys_probe",
    label: "System Probe",
    description:
      "Read-only Linux facts: host (resources, session dependencies, toolchain presence), devices (serial/GPIO/I2C/SPI/GPU nodes without opening them), listeners, services or processes. Use before host/embedded operations or instead of parsing ss/systemctl/ps. Bounded metadata and compact rows; never flashes, controls or stress-tests hardware.",
    promptSnippet:
      "Inspect host/session dependencies, hardware nodes, ports, services or processes",
    promptGuidelines: [
      "Use sys_probe instead of parsing `ss`, `systemctl` or `ps` output in bash.",
      "Before host or hardware changes, inspect sys_probe host/devices and preserve the active machine, connectivity and session; presence is not authorization or target identity.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("listeners"),
        Type.Literal("services"),
        Type.Literal("processes"),
        Type.Literal("host"),
        Type.Literal("devices"),
      ]),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }),
    async execute(_id: any, params: { action: string; limit?: number }, signal?: AbortSignal) {
      try {
        const limit = Math.min(Math.max(Number(params.limit) || 100, 1), 200);
        const deadline = AbortSignal.timeout(5000);
        const result = await runSysProbe(params.action, limit, signal ? AbortSignal.any([signal, deadline]) : deadline);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: { action: params.action, rows: result.rows.length },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : "sys_probe failed",
            },
          ],
        };
      }
    },
  });
}
