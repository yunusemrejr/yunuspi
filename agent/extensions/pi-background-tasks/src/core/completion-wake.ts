import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
/** Completion observations are durable independently of permission to start inference. */
export function pausesCompletionWake(message: any): boolean {
  // agent_settled occurs after ordinary retries. Any terminal failure/abort must
  // retain the core's pause decision, including cooldown exhaustion and Escape.
  return (
    message?.role === "assistant" &&
    ["error", "aborted"].includes(message.stopReason)
  );
}
export function createCompletionNotifier(
  pi: ExtensionAPI,
  context: () => ExtensionContext | undefined,
) {
  let blocked = false, compactionBlocked = false, active = true, flushing = false,
    pending = 0;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  const clearWake = () => { if (wakeTimer) clearTimeout(wakeTimer); wakeTimer = undefined; };
  const flush = () => {
    if (!active || flushing || !pending || blocked || compactionBlocked || context()?.signal?.aborted || !context()?.isIdle()) return;
    const count = pending;
    flushing = true;
    try { pi.sendMessage(
      {
        customType: "background-completion-wake",
        content: `${count} background task completion(s) were recorded above. Use their durable terminal results; do not rerun completed work.`,
        display: false,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
    pending = Math.max(0, pending - count);
    } catch {
      console.warn("[background-tasks] Completion wake deferred: message delivery failed.");
    } finally { flushing = false; }
  };
  pi.on("session_start", (_event, ctx) => {
    clearWake(); active = true; compactionBlocked = false; pending = 0;
    const last = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find(
        (e: any) => e.type === "message" && e.message.role === "assistant",
      ) as any;
    blocked = pausesCompletionWake(last?.message);
  });
  pi.on("message_end", (event) => {
    if (pausesCompletionWake(event.message)) blocked = true;
    else if (
      event.message.role === "assistant" &&
      !["error", "aborted"].includes(event.message.stopReason)
    )
      blocked = false;
  });
  pi.on("input", (event) => {
    if (event.source !== "extension") {
      clearWake(); blocked = false; compactionBlocked = false;
      pending = 0;
    }
  });
  pi.on("session_compact_failed", () => {
    compactionBlocked = true;
  });
  pi.on("session_compact", () => {
    compactionBlocked = false;
    // Core emits this before releasing its compaction busy flag. One deferred
    // check bridges that lifecycle boundary without polling or a second queue.
    clearWake();
    wakeTimer = setTimeout(() => { wakeTimer = undefined; flush(); }, 0);
    wakeTimer.unref?.();
  });
  pi.on("agent_settled", flush);
  pi.on("session_shutdown", () => {
    clearWake(); active = false; pending = 0;
  });
  return (message: any, options: { triggerTurn: boolean }) => {
    if (!active) return;
    // triggerTurn:false also bypasses the follow-up queue during an active run.
    // Thus completions queued before a later invalid request cannot re-wake it.
    pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: false });
    if (options.triggerTurn) {
      pending++;
      flush();
    }
  };
}
