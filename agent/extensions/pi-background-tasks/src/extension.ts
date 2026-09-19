import { defaultCompletionTrigger, serviceNotificationOnly, taskTriggersCompletion } from "./core/service-policy.ts";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
  ThemeColor,
  ToolRenderResultOptions,
} from "@yunuspi/coding-agent";
import { formatSize } from "@yunuspi/coding-agent";
import { Text, type KeyId } from "@yunuspi/tui";
import { Type, type Static } from "typebox";
import {
  DEFAULT_LOG_BYTES,
  MAX_LOG_BYTES,
  deriveCompletionDeliveryGuidance,
  deriveTaskNameFromCommand,
  formatSnapshotList,
  normalizeMaxBytes,
  normalizeTaskName,
  parseBgCommandArgs,
  taskDisplayName,
  truncateChars,
  type BgKillDetails,
  type BgLogsDetails,
  type BgRunDetails,
  type BgStatusDetails,
  type BgTask,
  type BgTaskSnapshot,
  type StartTaskOptions,
} from "./core/common.js";
import {
  readPackageInfo,
} from "./core/update-check.js";
import { BackgroundTaskRegistry, MAX_TASK_TIMEOUT_SECONDS } from "./core/registry.js";
import { registerContinuationSource } from "../../lib/continuation-notice.ts";
import {
  installBackgroundTaskExtensionApi,
  type BackgroundTaskExtensionService,
} from "./core/extension-api.js";
import {
  BackgroundTasksManager,
  type BackgroundTaskForUi,
  type TaskManagerResult,
} from "./ui/background-tasks-manager.js";
/**
 * Project-local Pi background task manager.
 *
 * Scope:
 * - Explicit background shell jobs only: /bg and bg_run spawn commands directly.
 * - This registry is authoritative for explicit background jobs; managed-bash's
 *   `process` tool owns only bounded internal wait_for/render helper captures.
 * - No Ctrl+B support for backgrounding an already-running built-in bash tool.
 * - No detached/restart reattachment: live child processes belong to this Pi
 *   extension runtime and are killed on session shutdown/reload.
 */

const STATUS_INTERVAL_MS = 1000;
const COMMAND_PREVIEW_CHARS = 90;

const packageInfo = readPackageInfo(
  new URL("../package.json", import.meta.url),
  (error) => {
    console.error(
      `[background-tasks] failed to read package version: ${error.message}`,
    );
  },
);
const PACKAGE_VERSION = packageInfo.version;
const LIGHT_BLUE_BG = "\x1b[48;2;183;223;255m";
const LIGHT_BLUE_FG = "\x1b[38;2;11;70;110m";
const ANSI_RESET = "\x1b[0m";

function lightBlue(value: string): string {
  return `${LIGHT_BLUE_BG}${LIGHT_BLUE_FG}${value}${ANSI_RESET}`;
}

function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

interface TextToolResult {
  content?: ReadonlyArray<{ type: string; text?: string }>;
}

interface BgToolArgumentRecord {
  readonly command?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly isAgent?: unknown;
  readonly timeoutSeconds?: unknown;
  readonly notifyOnCompletion?: unknown;
  readonly triggerOnCompletion?: unknown;
}

function optionalTrimmed(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const BgRunParams = Type.Object({
  name: Type.String({
    description:
      "Short human-readable task name shown in the bg footer dock. Required; use 2-6 words, not the raw command.",
  }),
  command: Type.String({
    description: "Shell command to start in the background",
  }),
  isAgent: Type.Boolean({
    description:
      "Required. Set true only when this background task launches an LLM/agent process, such as a child `pi -p ...` or `pi --mode json ...`, so Pi-agent telemetry can be collected. Set false for scripts, tests, servers, sleeps, and ordinary shell commands.",
  }),
  description: Type.Optional(
    Type.String({
      description: "Optional longer human-readable context for the task",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Number({
      exclusiveMinimum: 0,
      maximum: MAX_TASK_TIMEOUT_SECONDS,
      description: "Optional timeout; task is failed and killed when exceeded",
    }),
  ),
  notifyOnCompletion: Type.Optional(
    Type.Boolean({
      description:
        "Whether to deliver the durable terminal notification. Default: true; disable only when deliberately taking over completion monitoring.",
    }),
  ),
  triggerOnCompletion: Type.Optional(
    Type.Boolean({
      description:
        "Whether that notification should automatically trigger a follow-up agent turn. Default: true for finite work, false for recognized persistent servers; requires notifyOnCompletion.",
    }),
  ),
});

const BgStatusParams = Type.Object({
  taskId: Type.Optional(
    Type.String({
      description:
        "Optional task ID or unambiguous prefix. If omitted, all running/recent tasks are returned.",
    }),
  ),
});

const BgLogsParams = Type.Object({
  taskId: Type.String({ description: "Task ID or unambiguous prefix" }),
  maxBytes: Type.Optional(
    Type.Number({
      description: `Maximum bytes to return, capped at ${formatSize(MAX_LOG_BYTES)}. Default: ${formatSize(DEFAULT_LOG_BYTES)}.`,
    }),
  ),
  tail: Type.Optional(
    Type.Boolean({
      description:
        "Read the tail of the log when true, head when false. Default: true.",
    }),
  ),
});

const BgKillParams = Type.Object({
  taskId: Type.String({ description: "Task ID or unambiguous prefix to stop" }),
});

type BgRunParamsValue = Static<typeof BgRunParams>;

function renderPlainResult(
  result: TextToolResult,
  options: ToolRenderResultOptions,
  theme: Theme,
) {
  void options;
  void theme;
  const text =
    result.content
      ?.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
      .join("\n") ?? "";
  return new Text(text, 0, 0);
}

import { createCompletionNotifier } from './core/completion-wake.ts';

export default function backgroundTasksExtension(pi: ExtensionAPI): void {
  const seenTaskIds = new Set<string>();
  let currentCtx: ExtensionContext | undefined;
  let dockOpen = false;
  let statusInterval: NodeJS.Timeout | undefined;

  const completionNotifier = createCompletionNotifier(pi, () => currentCtx);
  const registry = new BackgroundTaskRegistry({
    onChange: () => {
      updateUi();
    },
    sendCompletionNotification: completionNotifier,
    publishTerminal: (task) => {
      eventService.publishTerminal(task);
    },
  });
  const eventService: BackgroundTaskExtensionService =
    installBackgroundTaskExtensionApi({
      events: pi.events,
      registry,
      getContext: () => currentCtx,
      isShuttingDown: () => registry.isShuttingDown(),
    });

  // Continuation notice: report only tasks that will resume this session by themselves.
  registerContinuationSource({
    name: "background tasks",
    pending: () =>
      registry
        .allTasks()
        .filter((task) => task.status === "running" && taskTriggersCompletion(task))
        .map((task) => `${task.name || task.id} (${task.id}) will automatically resume this session when it finishes`),
  });

  function unseenFinishedTasks(): BgTask[] {
    return registry
      .allTasks()
      .filter((task) => task.status !== "running" && !seenTaskIds.has(task.id));
  }

  function clearFinishedNotices(ctx = currentCtx): number {
    const unseen = unseenFinishedTasks();
    for (const task of unseen) seenTaskIds.add(task.id);
    updateUi(ctx);
    return unseen.length;
  }

  function notifyClearFinishedNotices(ctx: ExtensionContext): void {
    currentCtx = ctx;
    const cleared = clearFinishedNotices(ctx);
    if (!ctx.hasUI) return;
    ctx.ui.notify(
      cleared > 0
        ? `Cleared ${String(cleared)} finished background task notice${cleared === 1 ? "" : "s"}.`
        : "No finished background task notices to clear.",
      cleared > 0 ? "info" : "warning",
    );
  }

  function updateUi(ctx = currentCtx): void {
    if (registry.isShuttingDown() || !ctx) return;
    try {
      if (!ctx.hasUI) return;
      const allTasks = registry.allTasks();
      const running = allTasks.filter((task) => task.status === "running");
      const unseenFailed = allTasks.filter(
        (task) => task.status === "failed" && !seenTaskIds.has(task.id),
      );
      const unseenStopped = allTasks.filter(
        (task) => task.status === "killed" && !seenTaskIds.has(task.id),
      );
      const unseenDone = allTasks.filter(
        (task) => task.status === "completed" && !seenTaskIds.has(task.id),
      );
      const unseenFinishedCount =
        unseenFailed.length + unseenStopped.length + unseenDone.length;
      const updateSegment = "";
      ctx.ui.setWidget("background-tasks", undefined);
      if (running.length === 0 && unseenFinishedCount === 0) {
        ctx.ui.setStatus(
          "background-tasks",
          updateSegment ? lightBlue(` bg ${updateSegment} `) : undefined,
        );
        return;
      }

      const parts: string[] = [];
      if (running.length > 0) parts.push(`${String(running.length)} running`);
      if (unseenFailed.length > 0)
        parts.push(`${String(unseenFailed.length)} failed`);
      if (unseenStopped.length > 0)
        parts.push(`${String(unseenStopped.length)} stopped`);
      if (unseenDone.length > 0)
        parts.push(`${String(unseenDone.length)} done`);
      const entryHint = dockOpen
        ? "focused"
        : `Shift↓${unseenFinishedCount > 0 ? " · /bg-clear" : ""}`;
      const segments = [...parts, entryHint];
      if (updateSegment) segments.push(updateSegment);
      const label = ` bg ${segments.join(" · ")} `;
      ctx.ui.setStatus("background-tasks", lightBlue(label));
    } catch (error) {
      console.error(
        `[background-tasks] UI update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      currentCtx = undefined;
    }
  }

  async function startTask(
    ctx: ExtensionContext,
    command: string,
    options: StartTaskOptions = {},
  ): Promise<BgTask> {
    currentCtx = ctx;
    return registry.startTask(ctx, command, options);
  }

  async function openTaskManager(
    ctx: ExtensionCommandContext | ExtensionContext,
    initialTaskId?: string,
  ): Promise<void> {
    currentCtx = ctx;
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Background task manager requires an interactive Pi UI. Use /jobs, /logs, or the bg_status/bg_logs tools in non-interactive mode.",
        "error",
      );
      return;
    }
    dockOpen = true;
    updateUi(ctx);
    try {
      await ctx.ui.custom<TaskManagerResult>(
        (tui, theme, _keybindings, done) => {
          const managerOptions = {
            getTasks: () => registry.allTasks(),
            stopTask: async (task: BackgroundTaskForUi) => {
              await registry.stopTask(registry.resolveTask(task.id), "user");
              updateUi(ctx);
            },
            stopAllRunning: async () => {
              const result = await registry.stopAllRunning("user");
              updateUi(ctx);
              return result;
            },
            rerunTask: async (task: BackgroundTaskForUi) => {
              const rerunOptions: StartTaskOptions = {
                name: taskDisplayName(task),
                isAgent: task.isAgent,
                notifyOnCompletion: true,
                triggerOnCompletion: false,
              };
              if (task.description !== undefined)
                rerunOptions.description = task.description;
              if (task.timeoutSeconds !== undefined)
                rerunOptions.timeoutSeconds = task.timeoutSeconds;
              const rerun = await startTask(ctx, task.command, rerunOptions);
              updateUi(ctx);
              return rerun;
            },
            showOutputPath: (task: BackgroundTaskForUi) => {
              ctx.ui.notify(
                `Output path for ${taskDisplayName(task)} (${task.id}):\n${task.outputPath}`,
                "info",
              );
            },
            markSeen: (taskId: string) => {
              seenTaskIds.add(taskId);
              updateUi(ctx);
            },
            markFinishedSeen: (taskIds: string[]) => {
              for (const taskId of taskIds) seenTaskIds.add(taskId);
              updateUi(ctx);
            },
            isSeen: (taskId: string) => seenTaskIds.has(taskId),
          };
          if (initialTaskId)
            return new BackgroundTasksManager(tui, theme, done, {
              ...managerOptions,
              initialTaskId,
            });
          return new BackgroundTasksManager(tui, theme, done, managerOptions);
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "bottom-center",
            width: "96%",
            minWidth: 64,
            maxHeight: "60%",
            margin: { bottom: 1, left: 1, right: 1 },
          },
        },
      );
    } finally {
      dockOpen = false;
      updateUi(ctx);
    }
  }

  pi.registerMessageRenderer<BgTaskSnapshot>(
    "background-task-notification",
    (message, _options, theme) => {
      const task = message.details;
      const status = task?.status ?? "completed";
      const color: ThemeColor =
        status === "completed"
          ? "success"
          : status === "failed"
            ? "error"
            : status === "killed"
              ? "warning"
              : "accent";
      const id = task?.id ?? "background task";
      const name = task ? taskDisplayName(task) : "Background task";
      const output = task?.outputPath
        ? `\n${theme.fg("dim", `Output: ${task.outputPath}`)}`
        : "";
      const error = task?.error ? `\n${theme.fg("error", task.error)}` : "";
      return new Text(
        `${theme.fg(color, `[bg ${status}]`)} ${theme.fg("accent", name)} ${theme.fg("dim", `(${id})`)}${output}${error}`,
        0,
        0,
      );
    },
  );

  pi.on("session_start", async (_event, ctx) => {
    registry.setShuttingDown(false);
    currentCtx = ctx;
    await registry.ensureRuntimeDir(ctx);
    updateUi(ctx);
    if (statusInterval) clearInterval(statusInterval);
    statusInterval = setInterval(() => {
      updateUi();
    }, STATUS_INTERVAL_MS);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    registry.setShuttingDown(true);
    currentCtx = undefined;
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = undefined;
    }
    try {
      const running = registry
        .allTasks()
        .filter((task) => task.status === "running");
      if (running.length === 0) return;

      const failures: string[] = [];
      await Promise.all(
        running.map(async (task) => {
          try {
            await registry.stopTask(
              task,
              "shutdown",
              "Killed during Pi session shutdown/reload",
            );
          } catch (error) {
            const message = `${task.id}: ${error instanceof Error ? error.message : String(error)}`;
            failures.push(message);
            console.error(
              `[background-tasks] shutdown cleanup failed for ${message}`,
            );
          }
        }),
      );
      if (failures.length > 0 && ctx.hasUI) {
        ctx.ui.notify(
          `Background task cleanup failed:\n${failures.join("\n")}`,
          "error",
        );
      }
    } finally {
      eventService.close();
    }
  });

  pi.registerCommand("bg", {
    description:
      'Start a shell command as a tracked background task: /bg [--agent] [--name "Task name"] <command>',
    handler: async (args, ctx) => {
      try {
        const parsed = parseBgCommandArgs(args);
        const taskOptions: StartTaskOptions = {
          isAgent: parsed.isAgent,
          notifyOnCompletion: true,
          triggerOnCompletion: false,
        };
        if (parsed.name !== undefined) taskOptions.name = parsed.name;
        const task = await startTask(ctx, parsed.command, taskOptions);
        ctx.ui.notify(
          `Started ${taskDisplayName(task)} (${task.id})\nOutput: ${task.outputPath}\nCommand: ${task.command}`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `Background task failed to start: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("tasks", {
    description: "Open the Claude-like background task manager UI",
    handler: async (args, ctx) => {
      const taskId = optionalTrimmed(args);
      await openTaskManager(ctx, taskId);
    },
  });

  pi.registerCommand("bg-tasks", {
    description: "Open the background task manager UI",
    handler: async (args, ctx) => {
      const taskId = optionalTrimmed(args);
      await openTaskManager(ctx, taskId);
    },
  });

  pi.registerCommand("bg-clear", {
    description: "Clear finished background task footer notices",
    handler: (_args, ctx) => {
      notifyClearFinishedNotices(ctx);
      return Promise.resolve();
    },
  });

  pi.registerCommand("bg-update", {
    description:
      "Show the local-fork update status; never replace the installed extension",
    handler: (_args, ctx) => {
      const current = PACKAGE_VERSION ?? "unknown";
      const lines = [
        `YunusPi background-task fork ${current} is installed.`,
        "This source-owned extension changes only with a reviewed YunusPi release.",
        "No upstream package version checks or automatic replacements are performed.",
      ];
      ctx.ui.notify(lines.join("\n"), "info");
      return Promise.resolve();
    },
  });

  pi.registerShortcut("shift+down" satisfies KeyId, {
    description: "Open focused background task footer dock",
    handler: async (ctx) => {
      await openTaskManager(ctx);
    },
  });

  pi.registerShortcut("ctrl+alt+c" satisfies KeyId, {
    description:
      "Clear finished background task footer notices (terminal-dependent fallback for /bg-clear)",
    handler: (ctx) => {
      notifyClearFinishedNotices(ctx);
    },
  });

  pi.registerCommand("jobs", {
    description: "List running and recent background tasks",
    handler: (_args, ctx) => {
      currentCtx = ctx;
      ctx.ui.notify(
        formatSnapshotList(
          registry.allTasks().map((task) => registry.snapshot(task)),
        ),
        "info",
      );
      updateUi(ctx);
      return Promise.resolve();
    },
  });

  pi.registerCommand("logs", {
    description:
      "Show bounded output from a background task: /logs <id> [maxBytes]",
    getArgumentCompletions: (prefix) => {
      const matches = registry
        .allTasks()
        .filter((task) => task.id.startsWith(prefix.trim()))
        .slice(0, 20)
        .map((task) => ({
          value: task.id,
          label: `${task.id} ${taskDisplayName(task)}`,
          description: `${task.status} — ${truncateChars(task.command, 60)}`,
        }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      try {
        currentCtx = ctx;
        const [id, bytes] = args.trim().split(/\s+/, 2);
        const task = registry.resolveTask(id ?? "");
        const maxBytes = normalizeMaxBytes(Number(bytes), DEFAULT_LOG_BYTES);
        const logs = await registry.getTaskLogs(task, maxBytes, true);
        ctx.ui.notify(logs.text, "info");
      } catch (error) {
        ctx.ui.notify(
          `Background logs error: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("kill", {
    description: "Stop a running background task: /kill <id>",
    getArgumentCompletions: (prefix) => {
      const matches = registry
        .allTasks()
        .filter(
          (task) =>
            task.status === "running" && task.id.startsWith(prefix.trim()),
        )
        .slice(0, 20)
        .map((task) => ({
          value: task.id,
          label: `${task.id} ${taskDisplayName(task)}`,
          description: truncateChars(task.command, 70),
        }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      try {
        currentCtx = ctx;
        const task = registry.resolveTask(args.trim());
        await registry.stopTask(task, "user");
        ctx.ui.notify(
          `Killed ${taskDisplayName(task)} (${task.id}). Output: ${task.outputPath}`,
          "info",
        );
        updateUi(ctx);
      } catch (error) {
        ctx.ui.notify(
          `Background kill error: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerTool<typeof BgRunParams, BgRunDetails>({
    name: "bg_run",
    label: "Background Run",
    description: `Start a named long-running shell command in the explicit background-task registry; returns immediately with a task ID and output path. Terminal state (completed/failed/killed) is delivered as <background-task-notification>. Finite work defaults to one coalesced follow-up after it settles; recognized persistent services default to a durable UI/receipt update without waking the agent, and wake only when triggerOnCompletion:true is explicitly requested (errors/aborts preserve pause). Never sleep or poll to wait. Manage these IDs with bg_status/bg_logs/bg_kill; they do not appear in managed-bash's process tool. Logs are bounded to ${formatSize(MAX_LOG_BYTES)}.`,
    promptSnippet:
      "Start named background work; finite completion can wake once, while persistent services default to UI-only status",
    promptGuidelines: [
      "Use bash for short commands; bg_run for long tests/builds/servers. Give bg_run a short name; isAgent is true only for LLM processes. Keep completion notifications enabled; finite tasks request one coalesced wake by default, while recognized persistent services stay UI/receipt-only unless triggerOnCompletion:true is explicit. Do other work or yield rather than poll. A terminal notification is authoritative; inspect its logs when needed, then report the result—not success before completion.",
    ],
    parameters: BgRunParams,
    prepareArguments(args): BgRunParamsValue {
      if (!args || typeof args !== "object")
        throw new Error("bg_run arguments must be an object");
      const input = args as BgToolArgumentRecord;
      if (typeof input.command !== "string")
        throw new Error("bg_run requires command string");
      if (typeof input.isAgent !== "boolean") {
        throw new Error(
          "bg_run requires isAgent boolean. Set true only for LLM/agent tasks; set false for scripts, tests, servers, sleeps, and ordinary shell commands.",
        );
      }
      const prepared: BgRunParamsValue = {
        command: input.command,
        name:
          normalizeTaskName(input.name) ??
          normalizeTaskName(input.description) ??
          deriveTaskNameFromCommand(input.command),
        isAgent: input.isAgent,
      };
      if (typeof input.description === "string")
        prepared.description = input.description;
      if (typeof input.timeoutSeconds === "number")
        prepared.timeoutSeconds = input.timeoutSeconds;
      if (typeof input.notifyOnCompletion === "boolean")
        prepared.notifyOnCompletion = input.notifyOnCompletion;
      if (typeof input.triggerOnCompletion === "boolean")
        prepared.triggerOnCompletion = input.triggerOnCompletion;
      return prepared;
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (typeof params.isAgent !== "boolean") {
        throw new Error(
          "bg_run requires isAgent boolean. Set true only for LLM/agent tasks; set false for scripts, tests, servers, sleeps, and ordinary shell commands.",
        );
      }
      const taskOptions: StartTaskOptions = {
        name: params.name,
        isAgent: params.isAgent,
        notifyOnCompletion: params.notifyOnCompletion ?? true,
        triggerOnCompletion: defaultCompletionTrigger(params.command, params.isAgent, params.triggerOnCompletion),
        triggerOnCompletionExplicit: params.triggerOnCompletion !== undefined,
      };
      if (params.description !== undefined)
        taskOptions.description = params.description;
      if (params.timeoutSeconds !== undefined)
        taskOptions.timeoutSeconds = params.timeoutSeconds;
      const task = await startTask(ctx, params.command, taskOptions);
      const completionDelivery = serviceNotificationOnly(task)
        ? { text: "Persistent service: completion is recorded in task status and the UI only; no agent turn will start. Continue the task without waiting for this server to exit." }
        : deriveCompletionDeliveryGuidance(task.notifyOnCompletion, taskTriggersCompletion(task));
      return {
        content: textContent(
          `Started background task ${taskDisplayName(task)} (${task.id})\nStatus: ${task.status}\nPID: ${String(task.pid ?? "unknown")}\nOutput: ${task.outputPath}\n${completionDelivery.text}`,
        ),
        details: { task: registry.snapshot(task) },
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("bg_run "))}${theme.fg("muted", truncateChars(taskDisplayName(args), COMMAND_PREVIEW_CHARS))}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const { task } = result.details;
      return new Text(
        `${theme.fg("success", "✓ started")} ${theme.fg("accent", taskDisplayName(task))} ${theme.fg("dim", `(${task.id})`)}\n${theme.fg("dim", `Output: ${task.outputPath}`)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool<typeof BgStatusParams, BgStatusDetails>({
    name: "bg_status",
    label: "Background Status",
    description:
      "Inspect one explicit bg_run task or list all running/recent tasks in the background-task registry. Managed-bash helper jobs belong to the process tool. This is a point-in-time inspection tool, not a waiting primitive.",
    promptSnippet:
      "Inspect point-in-time status for one or all background tasks; never poll it as a wait loop",
    promptGuidelines: [
      "Use bg_status for requested updates, disabled notifications or suspected hangs—not as a wait loop.",
    ],
    parameters: BgStatusParams,
    execute(_toolCallId, params) {
      const selected = params.taskId
        ? [registry.resolveTask(params.taskId)]
        : registry.allTasks();
      const snapshots = selected.map((task) => registry.snapshot(task));
      return Promise.resolve({
        content: textContent(formatSnapshotList(snapshots)),
        details: { tasks: snapshots },
      });
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("bg_status"))}${args.taskId ? ` ${theme.fg("accent", args.taskId)}` : ""}`,
        0,
        0,
      );
    },
    renderResult: renderPlainResult,
  });

  pi.registerTool<typeof BgLogsParams, BgLogsDetails>({
    name: "bg_logs",
    label: "Background Logs",
    description: `Read bounded output from an explicit bg_run task for deliberate inspection, not as a waiting primitive; capped at ${formatSize(MAX_LOG_BYTES)}, with a pointer to the full file when truncated. Managed-bash helper output belongs to the process tool.`,
    promptSnippet:
      "Read bounded task output when needed; never tail it repeatedly as a wait loop",
    promptGuidelines: [
      "Use bg_logs for needed evidence with a modest maxBytes; do not repeatedly tail it while waiting.",
    ],
    parameters: BgLogsParams,
    async execute(_toolCallId, params) {
      const task = registry.resolveTask(params.taskId);
      const logs = await registry.getTaskLogs(
        task,
        normalizeMaxBytes(params.maxBytes),
        params.tail ?? true,
      );
      return {
        content: textContent(logs.text),
        details: logs.details,
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("bg_logs "))}${theme.fg("accent", args.taskId)}`,
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details;
      let text = `${theme.fg("accent", taskDisplayName(details.task))} ${theme.fg("dim", `(${details.task.id})`)} ${theme.fg("muted", details.tail ? "tail" : "head")} ${formatSize(details.bytesRead)}`;
      if (details.truncated) text += theme.fg("warning", " (truncated)");
      text += `\n${theme.fg("dim", `Full output: ${details.path}`)}`;
      if (expanded) {
        const output = result.content
          .map((content) =>
            content.type === "text" ? content.text : "[image content]",
          )
          .join("\n");
        text += `\n${theme.fg("toolOutput", output.split("\n").slice(0, 30).join("\n"))}`;
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool<typeof BgKillParams, BgKillDetails>({
    name: "bg_kill",
    label: "Background Kill",
    description:
      "Stop a running background task by ID. Fails loudly if the task is unknown or already finished.",
    promptSnippet: "Stop a running background task by ID",
    promptGuidelines: [
      "Use bg_kill for explicit bg_run tasks on user cancellation or when no longer needed; use managed-bash's process for internal helpers.",
    ],
    parameters: BgKillParams,
    async execute(_toolCallId, params) {
      const task = registry.resolveTask(params.taskId);
      await registry.stopTask(task, "user");
      const message = `Killed background task ${taskDisplayName(task)} (${task.id}). Output: ${task.outputPath}`;
      return {
        content: textContent(message),
        details: { task: registry.snapshot(task), message },
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("bg_kill "))}${theme.fg("accent", args.taskId)}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const { task } = result.details;
      return new Text(
        `${theme.fg("warning", "■ killed")} ${theme.fg("accent", taskDisplayName(task))} ${theme.fg("dim", `(${task.id})`)}\n${theme.fg("dim", `Output: ${task.outputPath}`)}`,
        0,
        0,
      );
    },
  });
}
