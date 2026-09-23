// Session self-stop: explicit completion marker for the main session.
// Review and delegation receipts are informational evidence, not permission
// to stop. Requiring either would create unnecessary model work just to end
// a simple task, or trap completion when independent capacity is unavailable.
//
// Enforcement is process-local (per cwd+session scope). The branch ledger
// entry ('session-stop-v1') is evidence only, never control state: a
// reload starts unstopped, and any genuine user input unlocks a stop as a
// standard continuation (quality triggers resume normally afterwards).
import path from "node:path";
import { collectSessionMetrics } from "./session-metrics.ts";

export const SESSION_STOP_ENTRY = "session-stop-v1";
/** (sessionId: string) => { stopped: string[]; failed: { id: string; error: string }[] } */
export const STOP_ALL_RUNS = Symbol.for("yunus-pi.subagent-stop-all.v1");

export type StopGate = { met: boolean; detail: string };
export type StopGates = { quality: StopGate; subagent: StopGate; met: boolean; required: false };

const states = new Map<string, { stopId: string; at: string; announced: boolean }>();

export function stopScopeKey(ctx: any): string | undefined {
  try {
    const session = ctx?.sessionManager?.getSessionId?.();
    const cwd = ctx?.cwd;
    if (typeof session !== "string" || !session || typeof cwd !== "string" || !cwd)
      return undefined;
    // Canonicalize like the quality-review owner registry so the key is
    // stable across equivalent cwd spellings within one session.
    return JSON.stringify([path.resolve(cwd), session]);
  } catch {
    return undefined;
  }
}

/** A review counts only when a reviewer returned a real assessment. The
 * infra-blocked path (all reports 'unknown' with gaps) and refunded rounds
 * (no new reports) never satisfy the gate, however the verdict reads. */
export function qualityStopGate(entries: unknown): StopGate {
  if (!Array.isArray(entries)) return { met: false, detail: "branch unavailable" };
  let assessed = 0;
  for (const entry of entries) {
    const reports = (entry as any)?.type === "custom" &&
        (entry as any)?.customType === "quality-review-v1"
      ? (entry as any)?.data?.reports
      : undefined;
    if (!Array.isArray(reports)) continue;
    for (const report of reports) {
      if (report?.outcome === "pass" || report?.outcome === "changes") assessed++;
    }
  }
  return assessed > 0
    ? { met: true, detail: `${assessed} assessed aspect(s)` }
    : { met: false, detail: "no completed review with reviewer evidence" };
}

/** Only completed child runs count: failed, stopped, paused or queued runs
 * are not accurate subagent use. */
export function subagentStopGate(entries: unknown): StopGate {
  if (!Array.isArray(entries)) return { met: false, detail: "branch unavailable" };
  let completed = 0;
  try {
    completed = collectSessionMetrics(entries).agentsCompleted ?? 0;
  } catch {
    return { met: false, detail: "usage metrics unavailable" };
  }
  return completed > 0
    ? { met: true, detail: `${completed} completed run(s)` }
    : { met: false, detail: "no completed subagent run" };
}

export function stopGates(entries: unknown): StopGates {
  const quality = qualityStopGate(entries);
  const subagent = subagentStopGate(entries);
  // Preserve the historical `gates` response shape for observers while making
  // its advisory status explicit. Missing receipts never mean verified work.
  return { quality, subagent, met: quality.met && subagent.met, required: false };
}

/** Suppression fails open: an unidentifiable scope is never treated as
 * stopped, so a stop can neither leak across sessions nor stick forever. */
export function isSessionStopped(ctx: any): boolean {
  const key = stopScopeKey(ctx);
  // An announce-only marker carries no stopId and must never suppress.
  return key !== undefined && (states.get(key)?.stopId ?? "") !== "";
}

export function noteSessionStopped(ctx: any, stopId: string): boolean {
  const key = stopScopeKey(ctx);
  if (key === undefined || typeof stopId !== "string" || !stopId) return false;
  states.set(key, { stopId, at: new Date().toISOString(), announced: true });
  return true;
}

/** Genuine user input unlocks; extension-sourced wakes must never unlock. */
export function unlockSessionStop(ctx: any): boolean {
  const key = stopScopeKey(ctx);
  if (key === undefined) return false;
  return states.delete(key);
}

export function stopInputUnlocks(event: any, ctx: any): boolean {
  if (!event || event.source === "extension") return false;
  return unlockSessionStop(ctx);
}

/** Exactly-once "stop is now unlocked" notice per scope until the next
 * unlock clears it. A stop also marks announced so nothing queues behind it. */
export function shouldAnnounceStopUnlock(ctx: any): boolean {
  const key = stopScopeKey(ctx);
  if (key === undefined) return false;
  return !states.get(key)?.announced;
}

export function markStopUnlockAnnounced(ctx: any): void {
  const key = stopScopeKey(ctx);
  if (key === undefined) return;
  const current = states.get(key);
  states.set(key, { stopId: current?.stopId ?? "", at: current?.at ?? "", announced: true });
}
