import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tokenizeSimple } from "../../../lib/bash-routing.ts";
import { collectSessionCost } from "../../../lib/session-cost.ts";
import { mergeCostEvidence, readCostEvidence } from "../../../lib/cost-evidence.ts";
import { sanitizePathSegment, type BgTaskSnapshot } from "./common.js";

const FRAME_TYPE = "background-task-billing";
const MAX_RECORDS = 20_000;
const MAX_RUNS = 128;
const MAX_CAPTURE_CHARS = 16 * 1024 * 1024;
const customTypes = [
  "auxiliary-model-usage-v1", "subagent-cost-v1", "subagent-lifecycle-v1", "jev-usage-v1", "span-usage-v1",
];
export const backgroundCostRoute = { owner: "bg_run", provider: "yunuspi-background", model: "agent-task" };

export type BackgroundCostEvidence = {
  reported: number;
  estimated: number;
  unknown: boolean;
  subscription: boolean;
  seen: boolean;
  estimatedUsage?: boolean;
};

/** Billing frames originate inside the generated owned-Pi wrapper. The
 * per-task token prevents ordinary command stdout or legacy telemetry from
 * being interpreted as a charge. The capability stays outside tool results. */
export function createBackgroundCostCapture(command: string) {
  const token = randomBytes(24).toString("hex");
  const direct = tokenizeSimple(command)?.[0] === "pi" && !/\$\(|`/.test(command);
  type Invocation = { sequence: number; ended: boolean; entries: any[]; ids: Set<string> };
  const invocations = new Map<string, Invocation>();
  let count = 0, chars = 0, incomplete = false;
  return {
    token,
    accept(frame: any, frameChars: number) {
      if (frame?.type !== FRAME_TYPE) return false;
      if (frame.token !== token) return true;
      if (typeof frame.invocation !== "string" || !/^[0-9a-f-]{36}$/.test(frame.invocation)
        || !Number.isSafeInteger(frame.sequence) || frame.sequence < 1) { incomplete = true; return true; }
      let current = invocations.get(frame.invocation);
      if (!current) {
        if (invocations.size >= MAX_RUNS) { incomplete = true; return true; }
        current = { sequence: 0, ended: false, entries: [], ids: new Set() };
        invocations.set(frame.invocation, current);
      }
      if (frame.sequence <= current.sequence) return true;
      if (frame.sequence !== current.sequence + 1 || current.ended) incomplete = true;
      current.sequence = frame.sequence;
      if (frame.kind === "start") return true;
      if (frame.kind === "end") {
        current.ended = frame.complete === true;
        return true;
      }
      const entry = frame.entry;
      if (frame.kind !== "entry" || !entry || typeof entry !== "object"
        || count >= MAX_RECORDS || chars + frameChars > MAX_CAPTURE_CHARS) { incomplete = true; return true; }
      if (typeof entry.id === "string") {
        if (current.ids.has(entry.id)) return true;
        current.ids.add(entry.id);
      }
      count++;
      chars += frameChars;
      current.entries.push(entry);
      return true;
    },
    settle(): BackgroundCostEvidence {
      let evidence: BackgroundCostEvidence = {reported:0, estimated:0, unknown:incomplete || !direct || invocations.size !== 1, subscription:false, seen:false};
      for (const run of invocations.values()) {
        const usage = collectSessionCost(run.entries);
        evidence = mergeCostEvidence(evidence, {
          ...usage, unknown: usage.unknown || !run.ended || (!usage.seen && !usage.subscription),
        });
      }
      return evidence;
    },
  };
}

/** Source embedded in the existing CommonJS telemetry wrapper. Only compact
 * billing fields cross the shell stdout boundary. */
export function backgroundCostControlSource(token?: string) {
  return `
const billingToken = ${JSON.stringify(token)};
const billingInvocation = billingToken ? require("node:crypto").randomUUID() : undefined;
const billingTypes = new Set(${JSON.stringify(customTypes)});
let billingSequence = 0, billingHeader = false;
function billingFrame(kind, value = {}) {
  if (!billingToken) return;
  process.stdout.write(JSON.stringify({ type: ${JSON.stringify(FRAME_TYPE)}, token: billingToken,
    invocation: billingInvocation, sequence: ++billingSequence, kind, ...value }) + "\\n");
}
function billingEvent(event) {
  if (!billingToken || !event || typeof event !== "object") return;
  if (event.type === "session" && typeof event.id === "string" && !billingHeader) {
    billingHeader = true;
    billingFrame("start");
    return;
  }
  if (!billingHeader) return;
  let entry;
  if (event.type === "entry_appended" && event.entry?.type === "custom" && billingTypes.has(event.entry.customType)) entry = event.entry;
  else if (event.type === "compaction_end" && event.result?.usage) {
    const usage = event.result.usage;
    const id = Array.isArray(usage.summaryReceiptIds) ? "compaction:" + usage.summaryReceiptIds.join(":") : undefined;
    entry = { type: "compaction", id, usage };
  } else if (event.type === "message_end" || event.type === "tool_result_end") {
    const message = event.message;
    if (message?.role === "assistant") {
      const { provider, model, usage, responseId } = message;
      entry = { type: "message", message: { role: "assistant", provider, model, usage, responseId } };
    } else if (message?.role === "toolResult" && message.usage && !["subagent", "bg_wait"].includes(message.toolName)) {
      const { toolName, toolCallId, usage } = message;
      entry = { type: "message", id: typeof toolCallId === "string" ? "tool:" + toolCallId : undefined,
        message: {role: "toolResult", toolName, usage} };
    }
  }
  if (entry) billingFrame("entry", { entry });
}
`;
}

export function unknownBackgroundCost(): BackgroundCostEvidence {
  return readCostEvidence(undefined);
}

/** Restore a durable terminal amount after an interrupted parent append.
 * Pending receipts name exact task metadata for this session. Do not sweep
 * directories or trust generic tokenUsage/costTotal in the old protocol. */
export async function recoverBackgroundCost(
  entries: readonly any[], cwd: string, sessionId: string,
) {
  const pending = new Map<string, string>(), finished = new Set<string>();
  for (const entry of entries) {
    const data = entry?.type === "custom" && entry.customType === "auxiliary-model-usage-v1" ? entry.data : undefined;
    if (data?.owner !== backgroundCostRoute.owner || data?.provider !== backgroundCostRoute.provider
      || data?.model !== backgroundCostRoute.model || typeof data.id !== "string" || !/^b[0-9a-f]{8}$/.test(data.id)) continue;
    if (data.status !== "pending") finished.add(data.id);
    else if (typeof data.metadataRef === "string") pending.set(data.id, data.metadataRef);
  }
  for (const id of finished) pending.delete(id);
  if (!pending.size) return [];
  const root = await realpath(cwd);
  const recovered = [];
  for (const [id, ref] of [...pending].slice(-64)) {
    const parts = ref.split("/");
    const directory = parts[2] ?? "";
    const prefix = `${sanitizePathSegment(sessionId)}-`;
    if (parts.length !== 4 || parts[0] !== ".pi" || parts[1] !== "tasks" || parts[3] !== `${id}.json`
      || !directory.startsWith(prefix) || !/^\d+$/.test(directory.slice(prefix.length))) continue;
    const file = join(root, ...parts);
    try {
      if (await realpath(file) !== file) continue;
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 512 * 1024) continue;
        const raw = Buffer.alloc(stat.size);
        const { bytesRead } = await handle.read(raw, 0, raw.length, 0);
        const task = JSON.parse(raw.toString("utf8", 0, bytesRead)) as BgTaskSnapshot;
        if (task.id !== id || task.isAgent !== true || task.cwd !== cwd
          || !["completed", "killed", "failed"].includes(task.status) || !task.costEvidence) continue;
        recovered.push({
          ...backgroundCostRoute, id,
          status: task.status === "completed" ? "completed" : task.status === "killed" ? "cancelled" : "failed",
          usage: {costDetails: readCostEvidence({costDetails: task.costEvidence})},
        });
      } finally { await handle.close(); }
    } catch { /* Missing, incomplete or inaccessible terminal metadata stays unresolved. */ }
  }
  return recovered;
}
