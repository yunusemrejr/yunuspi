import { serviceNotificationOnly } from "./service-policy.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@yunuspi/coding-agent";
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
  options: { graceMs?: number } = {},
) {
  const graceMs = Number.isFinite(options.graceMs)
    ? Math.max(0, Math.min(1000, options.graceMs!)) : 200;
  let blocked = false, compactionBlocked = false, active = true,
    pending = 0, generation = 0, drainRequested = false;
  let inFlight: object | undefined;
  let graceDeadline: number | undefined;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let compactTimer: ReturnType<typeof setTimeout> | undefined;
  let wakeSignal: AbortSignal | undefined, wakeAbort: (() => void) | undefined;
  const clearWake = () => {
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = undefined;
    if (wakeAbort) wakeSignal?.removeEventListener("abort", wakeAbort);
    wakeSignal = undefined; wakeAbort = undefined;
  };
  const clearCompact = () => { if (compactTimer) clearTimeout(compactTimer); compactTimer = undefined; };
  const flush = async () => {
    if (inFlight) { drainRequested = true; return; }
    if (!active || !pending || blocked || compactionBlocked || context()?.signal?.aborted || !context()?.isIdle()) return;
    const count = pending, ticket = generation;
    const deadline = graceDeadline;
    clearWake(); graceDeadline = undefined;
    const delivery = {};
    inFlight = delivery;
    drainRequested = false;
    let delivered = false, finished = false, rejected = false;
    const finish = () => {
      if (inFlight !== delivery) return;
      inFlight = undefined;
      const requested = drainRequested;
      drainRequested = false;
      if (requested && (delivered || ticket !== generation) && active && pending) requestFlush();
    };
    const accepted = () => {
      if (delivered || rejected || inFlight !== delivery) return;
      delivered = true;
      if (ticket === generation) pending = Math.max(0, pending - count);
      if (finished) finish();
    };
    try {
      await pi.sendMessage(
      {
        customType: "background-completion-wake",
        content: `${count} background task completion(s) were recorded above. Use their durable terminal results; do not rerun completed work.`,
        display: false,
      },
      { deliverAs: "followUp", triggerTurn: true, onAccepted: accepted },
      );
    } catch {
      // A model error after acceptance must not replay this already-recorded wake.
      rejected = !delivered;
      if (rejected && ticket === generation && graceDeadline === undefined) graceDeadline = deadline;
      if (rejected && inFlight === delivery) console.warn("[background-tasks] Completion wake deferred: message delivery failed.");
      finished = true;
      finish();
      return;
    } finally {
      // A resolved send may mean only volatile queue admission. Keep this
      // delivery single-flight until its actual history acceptance callback.
      if (!finished) { finished = true; if (delivered) finish(); }
    }
  };
  const requestFlush = () => {
    const ctx = context();
    if (!active || !pending || blocked || compactionBlocked || ctx?.signal?.aborted) return;
    // A missing deadline means this batch is already in flight. Only a newly
    // accepted receipt can open another grace window while it is being sent.
    if (graceDeadline === undefined) return;
    const remaining = graceDeadline - performance.now();
    if (remaining <= 0) { void flush(); return; }
    if (wakeTimer) return;
    const ticket = generation;
    const timer = setTimeout(() => {
      if (wakeTimer !== timer || ticket !== generation) return;
      clearWake();
      requestFlush();
    }, Math.ceil(remaining));
    wakeTimer = timer;
    timer.unref?.();
    wakeSignal = ctx?.signal;
    wakeAbort = () => { clearWake(); clearCompact(); blocked = true; };
    wakeSignal?.addEventListener("abort", wakeAbort, { once: true });
    if (wakeSignal?.aborted) wakeAbort();
  };
  pi.on("session_start", (_event, ctx) => {
    generation++; clearWake(); clearCompact(); graceDeadline = undefined; inFlight = undefined; drainRequested = false; active = true; compactionBlocked = false; pending = 0;
    const last = [...ctx.sessionManager.getBranch()]
      .reverse()
      .find(
        (e: any) => e.type === "message" && e.message.role === "assistant",
      ) as any;
    blocked = pausesCompletionWake(last?.message);
  });
  pi.on("message_end", (event) => {
    if (pausesCompletionWake(event.message)) { blocked = true; clearWake(); clearCompact(); }
    else if (
      event.message.role === "assistant" &&
      !["error", "aborted"].includes(event.message.stopReason)
    )
      blocked = false;
  });
  pi.on("input", (event) => {
    if (event.source !== "extension") {
      generation++; clearWake(); clearCompact(); graceDeadline = undefined; inFlight = undefined; drainRequested = false; blocked = false; compactionBlocked = false;
      pending = 0;
    }
  });
  pi.on("session_compact_failed", () => {
    compactionBlocked = true;
    clearWake(); clearCompact();
  });
  pi.on("session_compact", () => {
    compactionBlocked = false;
    // Core emits this before releasing its compaction busy flag. One deferred
    // check bridges that lifecycle boundary without polling or a second queue.
    clearCompact();
    const ticket = generation;
    const timer = setTimeout(() => {
      if (compactTimer !== timer || ticket !== generation) return;
      compactTimer = undefined; requestFlush();
    }, 0);
    compactTimer = timer;
    timer.unref?.();
  });
  pi.on("agent_settled", requestFlush);
  pi.on("session_shutdown", () => {
    generation++; clearWake(); clearCompact(); graceDeadline = undefined; inFlight = undefined; drainRequested = false; active = false; pending = 0;
  });
  return (message: any, options: { triggerTurn: boolean }) => {
    if (!active) return;
    if (serviceNotificationOnly(message?.details ?? {})) {
      // The registry already persisted the terminal snapshot. Services never
      // add hidden model context or a pending continuation merely by exiting.
      const task = message.details;
      try { context()?.ui?.notify?.(`Background service ${task.name || task.id || ""} ${task.status || "finished"}.`, "info"); } catch { /* Durable task metadata remains authoritative if the UI is unavailable. */ }
      return;
    }
    // triggerTurn:false also bypasses the follow-up queue during an active run.
    // Thus completions queued before a later invalid request cannot re-wake it.
    const ticket = generation;
    let acknowledged = false;
    const accepted = () => {
      if (acknowledged) return;
      acknowledged = true;
      // Never wake a newer request for an old receipt or before its results arrive.
      if (active && ticket === generation && options.triggerTurn) {
        pending++;
        // Fixed first-arrival deadline: steady arrivals cannot postpone work.
        graceDeadline ??= performance.now() + graceMs;
        requestFlush();
      }
    };
    try {
      const receipt = pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: false, onAccepted: accepted });
      void Promise.resolve(receipt).catch(() => {});
    } catch {
      // The durable task record remains authoritative when a UI/session queue
      // is already closing; the next session_start will rediscover it.
    }
  };
}
