import type { SessionEntry } from "@yunuspi/coding-agent";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface FileCheckpoint {
  path: string;
  tool: string;
  callId: string;
  status: "pending" | "success" | "failed";
  bytes: number | null;
  readback?: string;
  integrity?: string;
}

export function checkpointPath(raw: string, cwd: string): string {
  return resolve(cwd, raw.replace(/^@/, "").replace(/^~(?=\/|$)/, homedir()));
}

// Rebuild from the active branch, not a parallel ledger or the model's summary.
// Tool results retain exact mutation receipts across compaction/reload/forks.
export function fileCheckpoints(entries: SessionEntry[], cwd: string): FileCheckpoint[] {
  const calls = new Map<string, { name: string; path: string; content?: string; batch: string }>();
  const results = new Map<string, Extract<SessionEntry, { type: "message" }>["message"]>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const m = entry.message;
    if (m.role === "assistant") {
      for (const call of m.content ?? []) {
        if (call.type !== "toolCall" || typeof call.arguments?.path !== "string") continue;
        if (!["write", "edit", "read", "read_symbol", "read_enclosing"].includes(call.name)) continue;
        calls.set(call.id, { name: call.name, path: checkpointPath(call.arguments.path, cwd),
          content: call.name === "write" ? call.arguments.content : undefined, batch: entry.id });
      }
    } else if (m.role === "toolResult") results.set(m.toolCallId, m);
  }
  const files = new Map<string, FileCheckpoint>();
  for (const [id, call] of calls) {
    const result = results.get(id);
    const done = result?.role === "toolResult" ? result : undefined;
    const receipt = done?.details?.fileMutation;
    const effectivePath = typeof receipt?.resolved === "string" ? checkpointPath(receipt.resolved, cwd)
      : typeof receipt?.path === "string" ? checkpointPath(receipt.path, cwd) : call.path;
    const previous = files.get(effectivePath);
    if (call.name !== "write" && call.name !== "edit") {
      if (done && !done.isError && previous && calls.get(previous.callId)?.batch !== call.batch)
        previous.readback = `${call.name} succeeded (may be partial)`;
      continue;
    }
    const status = !done ? "pending" : done.isError ? "failed" : "success";
    let bytes = previous?.bytes ?? null;
    if (receipt !== undefined) {
      bytes = typeof receipt?.bytes === "number" && Number.isFinite(receipt.bytes) && receipt.bytes >= 0 ? receipt.bytes : null;
    } else if (status === "success") {
      bytes = call.name === "write" && typeof call.content === "string" ? Buffer.byteLength(call.content) : null;
    }
    const failureText = done?.isError ? done.content.filter(p => p.type === "text").map(p => p.text).join("\n") : "";
    let integrity = previous?.integrity;
    if (/possible write degeneration|invalid filesystem path/.test(failureText))
      integrity = "corrupt-looking payload rejected; not an on-disk corruption verdict";
    else if (status === "success" && integrity)
      integrity = "successful mutation after rejected payload; repair not independently verified";
    if (status === "failed" && receipt !== undefined)
      integrity = "mutation receipt precedes tool result error; do not assume rollback";
    files.delete(effectivePath);
    files.set(effectivePath, { path: effectivePath, tool: call.name, callId: id, status, bytes, integrity });
  }
  return [...files.values()];
}

export function fileCheckpointText(files: FileCheckpoint[], budget = 1600): string {
  if (!files.length) return "";
  const unresolved = files.filter(f => f.status !== "success" || f.integrity);
  const unread = files.filter(f => f.status === "success" && !f.readback && !f.integrity);
  const lines = [`File checkpoints: ${files.length} files; ${unresolved.length} unresolved receipt(s), ${unread.length} successful mutation(s) without later readback. Prior tool receipts/sizes, not current disk validation; shell/external edits are untracked.`];
  let used = lines[0].length, shown = 0;
  // Retain consequential uncertainty first; do not replay every successful
  // file record into every request after compaction. Full receipts remain on demand.
  const selected = [...unresolved].reverse().concat([...unread].reverse()).slice(0, 6);
  for (const f of selected) {
    const line = `${JSON.stringify(f.path).replace(/[\u007f-\u009f\u2028\u2029]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}: ${f.tool} ${f.status}; size=${f.bytes ?? "unknown"} bytes${f.integrity ? `; ${f.integrity}` : "; no later readback"}`;
    if (used + line.length + 1 > budget - 140) break;
    lines.push(line); used += line.length + 1; shown++;
  }
  lines.push(`${shown < files.length ? `${files.length - shown} more file record(s)` : "Full file records"}: checkpoint_read({view:"files"}); query filters paths. Readback is not proof of correctness.`);
  return lines.join("\n");
}
