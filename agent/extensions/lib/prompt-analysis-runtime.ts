import {
  buildPromptAnalysisRequest,
  fallbackPromptAnalysis,
  parsePromptAnalysis,
  type PromptAnalysis,
  type PromptAnalysisKind,
  type PromptAnalysisPrevious,
} from "./prompt-interpretation.ts";
import { classifyFailure, type FailureCategory } from "../pi-subagents/src/runs/shared/failure-cause.ts";

export interface PromptAnalysisCandidate {
  route: string;
  complete: (input: { prompt: string; maxTokens: number; signal: AbortSignal }) => Promise<{
    text: string;
    inputTokens?: number;
    outputTokens?: number;
    stopReason?: string;
    reasoningTokens?: number;
  }>;
}

export type PromptAnalysisAttemptOutcome = "complete" | "malformed" | "truncated" | "empty" | "failed" | "timeout" | "late-complete" | "late-failed";
export interface PromptAnalysisAttempt {
  attempt: number;
  route: string;
  outcome: PromptAnalysisAttemptOutcome;
  usage: "known" | "unknown" | "pending";
  inputTokens?: number;
  outputTokens?: number;
  /** Private-safe category; provider error bodies are never copied to UI. */
  failureCategory?: FailureCategory;
  /** Wall-clock allowance that expired for a timeout outcome. */
  timeoutMs?: number;
  recovery?: "compact-retry";
  reasoningTokens?: number;
}

export interface PromptAnalysisRun {
  analysis?: PromptAnalysis;
  status: "model" | "fallback" | "cancelled";
  route?: string;
  durationMs: number;
  /** Sum of token usage observed before this run returned, including malformed attempts. */
  inputTokens?: number;
  outputTokens?: number;
  /** Completed attempts whose provider did not report usage. */
  usageUnknownAttempts: number;
  /** Timed-out/cancelled requests still in flight when this snapshot returned. */
  usagePendingAttempts: number;
  attempts: number;
}

// Account-backed providers can spend tens of seconds queued or reasoning.
// Follow-ups need the same transport allowance as initial requests, even
// though their answer budget is smaller. Preserve room for a full fallback.
const INITIAL_BUDGET_MS = 240_000;
const FOLLOWUP_BUDGET_MS = 240_000;
const INITIAL_ATTEMPT_MS = 120_000;
const FOLLOWUP_ATTEMPT_MS = 120_000;
const MAX_ROUTE_ATTEMPTS = 4;

function aborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function abortError(): Error {
  const error = new Error("Prompt analysis cancelled");
  error.name = "AbortError";
  return error;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function snapshot(input: {
  startedAt: number;
  now: () => number;
  analysis?: PromptAnalysis;
  status: PromptAnalysisRun["status"];
  route?: string;
  attempts: number;
  inputTokens: number;
  outputTokens: number;
  knownUsageObserved: boolean;
  usageStates: Map<number, "known" | "unknown" | "pending">;
}): PromptAnalysisRun {
  let usageUnknownAttempts = 0;
  let usagePendingAttempts = 0;
  for (const state of input.usageStates.values()) {
    if (state === "unknown") usageUnknownAttempts++;
    if (state === "pending") usagePendingAttempts++;
  }
  return {
    ...(input.analysis ? { analysis: input.analysis } : {}),
    status: input.status,
    ...(input.route ? { route: input.route } : {}),
    durationMs: Math.max(0, input.now() - input.startedAt),
    ...(input.knownUsageObserved ? { inputTokens: input.inputTokens, outputTokens: input.outputTokens } : {}),
    usageUnknownAttempts,
    usagePendingAttempts,
    attempts: input.attempts,
  };
}

/** One bounded analysis pass. Routes are tried in configured order, up to
 * four attempts and the total wall-clock budget. Malformed output and fast
 * failures advance immediately; a timed-out provider is observed for late
 * usage but its result can never be published. */
export async function runPromptAnalysis(input: {
  prompt: string;
  kind: PromptAnalysisKind;
  previous?: PromptAnalysisPrevious;
  /** Tracked R# brief; keeps multi-part criteria visible past the excerpt bound. */
  requirements?: string;
  candidates: PromptAnalysisCandidate[];
  signal?: AbortSignal;
  now?: () => number;
  /** Narrow timing seam for deterministic timeout and fallback tests. */
  budget?: { totalMs: number; perAttemptMs: number; maxAttempts?: number; maxTokens?: number };
  /** Called once per attempt outcome. Timed-out requests may produce a second
   * late-* event that reconciles pending usage for the same attempt number. */
  onAttempt?: (detail: PromptAnalysisAttempt) => void;
  onStart?: (detail: { attempt: number; route: string; timeoutMs: number; recovery?: "compact-retry" }) => void;
}): Promise<PromptAnalysisRun> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const totalBudget = input.budget?.totalMs ?? (input.kind === "initial" ? INITIAL_BUDGET_MS : FOLLOWUP_BUDGET_MS);
  const perAttempt = input.budget?.perAttemptMs ?? (input.kind === "initial" ? INITIAL_ATTEMPT_MS : FOLLOWUP_ATTEMPT_MS);
  const maxTokens = input.budget?.maxTokens ?? (input.kind === "initial" ? 768 : 320);
  const request = buildPromptAnalysisRequest(input.prompt, input.kind, input.previous, input.requirements);
  const maxAttempts = input.budget?.maxAttempts ?? MAX_ROUTE_ATTEMPTS;
  const candidates = input.candidates.slice(0, maxAttempts).map(candidate => ({ ...candidate, repair: false }));
  let repaired = false;
  const usageStates = new Map<number, "known" | "unknown" | "pending">();
  let attempts = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let knownUsageObserved = false;
  // Diagnostic consumers are optional and must not change route selection,
  // suppress a valid response, or create an unhandled late rejection.
  const reportAttempt = (detail: PromptAnalysisAttempt) => {
    try { input.onAttempt?.(detail); } catch { /* observability is best effort */ }
  };

  for (const candidate of candidates) {
    if (attempts >= maxAttempts) break;
    if (aborted(input.signal)) {
      return snapshot({ startedAt, now, status: "cancelled", attempts, inputTokens, outputTokens, knownUsageObserved, usageStates });
    }
    const remaining = totalBudget - (now() - startedAt);
    if (remaining < Math.min(1000, totalBudget / 20)) break;
    attempts++;
    const attempt = attempts;
    const controller = new AbortController();
    const onAbort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let settled = false;

    // Run the attempt inside a resolved promise so a synchronous throw from
    // complete() and a rejecting provider promise follow the same path, and a
    // never-settling fake/provider promise stays covered by our own deadline.
    const routesLeft = candidates.length - attempt + 1;
    // Preference order owns the allowance. Adding fallbacks must not make a
    // healthy preferred route time out sooner. Fast failures leave later
    // routes the remaining budget; a single absolute deadline bounds the run.
    const attemptBudget = routesLeft === 1 ? remaining : Math.min(perAttempt, remaining);
    try { input.onStart?.({ attempt, route: candidate.route, timeoutMs: Math.round(attemptBudget), ...(candidate.repair ? { recovery: "compact-retry" as const } : {}) }); } catch { /* optional UI */ }
    let operation: ReturnType<PromptAnalysisCandidate["complete"]>;
    try {
      operation = Promise.resolve().then(() => candidate.complete({
        prompt: candidate.repair ? request + "\nRecovery: return only intent, taskLabel, confidence and up to two exact explicitConstraints. Omit everything else. No reasoning prose." : request,
        maxTokens: candidate.repair ? maxTokens * 2 : maxTokens, signal: controller.signal,
      }));
    } catch (error) {
      operation = Promise.reject(error);
    }
    const observed = operation.then((result) => {
      settled = true;
      const usedInput = tokenCount(result?.inputTokens);
      const usedOutput = tokenCount(result?.outputTokens);
      const known = usedInput !== undefined || usedOutput !== undefined;
      usageStates.set(attempt, known ? "known" : "unknown");
      if (known) {
        knownUsageObserved = true;
        inputTokens += usedInput ?? 0;
        outputTokens += usedOutput ?? 0;
      }
      if (stopped) reportAttempt({
        attempt, route: candidate.route, outcome: "late-complete", usage: known ? "known" : "unknown",
        ...(usedInput !== undefined ? { inputTokens: usedInput } : {}),
        ...(usedOutput !== undefined ? { outputTokens: usedOutput } : {}),
      });
      return result;
    }, (error) => {
      settled = true;
      usageStates.set(attempt, "unknown");
      if (stopped) reportAttempt({ attempt, route: candidate.route, outcome: "late-failed", usage: "unknown" });
      throw error;
    });
    // The observer above intentionally runs even if the timeout wins. Attach
    // a terminal rejection observer so the late rejection is never unhandled.
    void observed.catch(() => {});

    const timeout = Symbol("prompt-analysis-timeout");
    const timeoutPromise = new Promise<typeof timeout>((resolve) => {
      timer = setTimeout(() => resolve(timeout), attemptBudget);
    });
    let rejectAbort: (() => void) | undefined;
    const abortPromise = input.signal
      ? new Promise<never>((_, reject) => {
          rejectAbort = () => reject(abortError());
          if (input.signal!.aborted) rejectAbort();
          else input.signal!.addEventListener("abort", rejectAbort, { once: true });
        })
      : undefined;

    try {
      const response = await Promise.race([observed, timeoutPromise, ...(abortPromise ? [abortPromise] : [])]);
      if (response === timeout) {
        stopped = true;
        usageStates.set(attempt, "pending");
        reportAttempt({ attempt, route: candidate.route, outcome: "timeout", usage: "pending", timeoutMs: Math.round(attemptBudget) });
        controller.abort(new Error("Prompt analysis route timed out"));
        continue;
      }
      if (aborted(input.signal)) {
        stopped = !settled;
        if (!settled) usageStates.set(attempt, "pending");
        return snapshot({ startedAt, now, status: "cancelled", attempts, inputTokens, outputTokens, knownUsageObserved, usageStates });
      }
      const result = response;
      // A provider can exhaust its allowance exactly after the closing JSON
      // delimiter. Validate the full answer first; retrying an already usable
      // advisory spends another call without adding evidence. Partial JSON
      // still fails the same strict parser and follows truncation recovery.
      const analysis = parsePromptAnalysis(result.text, input.prompt, input.kind);
      if (!analysis) {
        const outcome = result.stopReason === "length" ? "truncated" : !result.text?.trim() ? "empty" : "malformed";
        const retry = !repaired && attempts < maxAttempts && outcome === "truncated" && totalBudget - (now() - startedAt) >= Math.min(3000, totalBudget / 4);
        reportAttempt({
          attempt, route: candidate.route, outcome,
          ...(retry ? { recovery: "compact-retry" } : {}),
          ...(tokenCount(result.reasoningTokens) !== undefined ? { reasoningTokens: result.reasoningTokens } : {}),
          usage: usageStates.get(attempt) ?? "unknown",
          ...(tokenCount(result.inputTokens) !== undefined ? { inputTokens: result.inputTokens } : {}),
          ...(tokenCount(result.outputTokens) !== undefined ? { outputTokens: result.outputTokens } : {}),
        });
        if (retry) { repaired = true; candidates.splice(attempt, 0, { ...candidate, repair: true }); }
        continue;
      }
      reportAttempt({
        attempt, route: candidate.route, outcome: "complete",
        usage: usageStates.get(attempt) ?? "unknown",
        ...(tokenCount(result.inputTokens) !== undefined ? { inputTokens: result.inputTokens } : {}),
        ...(tokenCount(result.outputTokens) !== undefined ? { outputTokens: result.outputTokens } : {}),
      });
      return snapshot({ startedAt, now, analysis, status: "model", route: candidate.route, attempts, inputTokens, outputTokens, knownUsageObserved, usageStates });
    } catch (error) {
      // Only the caller can cancel the whole pass. A transport's own abort
      // is a failed route and must leave the configured fallback available.
      if (aborted(input.signal)) {
        stopped = !settled;
        if (!settled) usageStates.set(attempt, "pending");
        return snapshot({ startedAt, now, status: "cancelled", attempts, inputTokens, outputTokens, knownUsageObserved, usageStates });
      }
      if (!stopped) {
        usageStates.set(attempt, "unknown");
        const message = error instanceof Error ? error.message : "Prompt analysis route failed";
        const providerCode = /(?:\bHTTP\s+|\bAPI error\s*\()([45]\d\d)\b/i.exec(message)?.[1];
        const failureCategory = classifyFailure({ stage: "provider", error: true, providerCode, message }).category;
        reportAttempt({ attempt, route: candidate.route, outcome: "failed", usage: "unknown", failureCategory });
      }
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      if (rejectAbort) input.signal?.removeEventListener("abort", rejectAbort);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  if (aborted(input.signal)) {
    return snapshot({ startedAt, now, status: "cancelled", attempts, inputTokens, outputTokens, knownUsageObserved, usageStates });
  }
  return snapshot({
    startedAt, now, analysis: fallbackPromptAnalysis(input.prompt, input.kind), status: "fallback",
    attempts, inputTokens, outputTokens, knownUsageObserved, usageStates,
  });
}

export const promptAnalysisBudgets = Object.freeze({
  initialMs: INITIAL_BUDGET_MS,
  followupMs: FOLLOWUP_BUDGET_MS,
  initialPerAttemptMs: INITIAL_ATTEMPT_MS,
  followupPerAttemptMs: FOLLOWUP_ATTEMPT_MS,
  initialTokens: 768,
  followupTokens: 320,
  maxRouteAttempts: MAX_ROUTE_ATTEMPTS,
});
