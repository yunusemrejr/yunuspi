/**
 * sys_probe — structured Linux system inspection.
 *
 * Replaces parsing `ss` / `systemctl` / `ps` output in bash (small models
 * struggle with those column formats). Read-only subprocesses only; output is
 * structured JSON and bounded.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";
import {
  parsePsTop,
  parseServiceList,
  parseSsListeners,
  type Listener,
  type ProcessRow,
  type ServiceRow,
} from "./lib/sys-probe.ts";

const execFileP = promisify(execFile);
const COMMANDS = ["listeners", "services", "processes"] as const;

async function run(command: string, args: string[]): Promise<string> {
  try {
    const result = await execFileP(command, args, {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    });
    return String(result.stdout ?? "");
  } catch (error: any) {
    if (error?.code === "ENOENT")
      throw new Error(
        `${command} is not installed; this action needs it on PATH`,
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

export async function runSysProbe(
  action: string,
  limit: number,
): Promise<{ action: string; rows: Listener[] | ServiceRow[] | ProcessRow[] }> {
  if (action === "listeners") {
    const output = await run("ss", ["-tulpnH"]).catch(() =>
      run("ss", ["-tulpn"]),
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
    ]);
    return { action, rows: parseServiceList(output, limit) };
  }
  if (action === "processes") {
    const output = await run("ps", [
      "-eo",
      "pid=,ppid=,pcpu=,pmem=,comm=",
      "--sort=-pcpu",
    ]);
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
      "Structured read-only Linux inspection: listening ports (listeners), running services (services) or top processes (processes). Use this INSTEAD of parsing `ss`, `systemctl` or `ps` output in bash. Returns compact JSON rows; bounded to 5s and the requested limit.",
    promptSnippet:
      "List listening ports, running services or top processes as structured rows",
    promptGuidelines: [
      "Use sys_probe instead of parsing `ss`, `systemctl` or `ps` output in bash.",
    ],
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("listeners"),
        Type.Literal("services"),
        Type.Literal("processes"),
      ]),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }),
    async execute(_id: any, params: { action: string; limit?: number }) {
      try {
        const limit = Math.min(Math.max(Number(params.limit) || 100, 1), 200);
        const result = await runSysProbe(params.action, limit);
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
