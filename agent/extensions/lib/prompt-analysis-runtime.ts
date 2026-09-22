import {
  buildPromptAnalysisRequest,
  fallbackPromptAnalysis,
  parsePromptAnalysis,
  type PromptAnalysis,
  type PromptAnalysisKind,
  type PromptAnalysisPrevious,
} from "./prompt-interpretation.ts";

export interface PromptAnalysisCandidate {
  route: string;
  complete: (input: { prompt: string; maxTokens: number; signal: AbortSignal }) => Promise<{
    text: string;
    inputTokens?: number;
    outputTokens?: number;
  }>;
}

export type PromptAnalysisAttemptOutcome = "complete" | "malformed" | "failed" | "timeout" | "late-complete" | "late-failed";
export interface PromptAnalysisAttempt {
  attempt: number;
  route: string;
  outcome: PromptAnalysisAttemptOutcome;
  usage: "known" | "unknown" | "pending";
  inputTokens?: number;
  outputTokens?: number;
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

const INITIAL_BUDGET_MS = 11_000;
const FOLLOWUP_BUDGET_MS = 7_000;
const INITIAL_ATTEMPT_MS = 5_500;
const FOLLOWUP_ATTEMPT_MS = 3_500;
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
  candidates: PromptAnalysisCandidate[];
  signal?: AbortSignal;
  now?: () => number;
  /** Narrow timing seam for deterministic timeout and fallback tests. */
  budget?: { totalMs: number; perAttemptMs: number; maxAttempts?: number; maxTokens?: number };
  /** Called once per attempt outcome. Timed-out requests may produce a second
   * late-* event that reconciles pending usage for the same attempt number. */
  onAttempt?: (detail: PromptAnalysisAttempt) => void;
}): Promise<PromptAnalysisRun> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const totalBudget = input.budget?.totalMs ?? (input.kind === "initial" ? INITIAL_BUDGET_MS : FOLLOWUP_BUDGET_MS);
  const perAttempt = input.budget?.perAttemptMs ?? (input.kind === "initial" ? INITIAL_ATTEMPT_MS : FOLLOWUP_ATTEMPT_MS);
  const maxTokens = input.budget?.maxTokens ?? (input.kind === "initial" ? 768 : 320);
  const request = buildPromptAnalysisRequest(input.prompt, input.kind, input.previous);
  const candidates = input.candidates.slice(0, input.budget?.maxAttempts ?? MAX_ROUTE_ATTEMPTS);
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
    if (aborted(input.signal)) {
      return snapshot({ startedAt, now, status: "cancelled", attempts, inputTokens, outputTokens, knownUsageObserved, usageStates });
    }
    const remaining = totalBudget - (now() - startedAt);
    if (remaining <= 0) break;
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
    let operation: Promise<{ text: string; inputTokens?: number; outputTokens?: number }>;
    try {
      operation = Promise.resolve().then(() => candidate.complete({ prompt: request, maxTokens, signal: controller.signal }));
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
    }, () => {
      settled = true;
      usageStates.set(attempt, "unknown");
      if (stopped) reportAttempt({ attempt, route: candidate.route, outcome: "late-failed", usage: "unknown" });
      throw new Error("Prompt analysis route failed");
    });
    // The observer above intentionally runs even if the timeout wins. Attach
    // a terminal rejection observer so the late rejection is never unhandled.
    void observed.catch(() => {});

    // Reserve a fair share for each configured fallback. Otherwise the first
    // two slow providers consume the entire budget and priority 3 is dead code.
    const attemptBudget = Math.min(perAttempt, remaining / (candidates.length - attempt + 1));
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
        reportAttempt({ attempt, route: candidate.route, outcome: "timeout", usage: "pending" });
        controller.abort(new Error("Prompt analysis route timed out"));
        continue;
      }
      if (aborted(input.signal)) {
        stopped = !settled;
        if (!settled) usageStates.set(attempt, "pending");
        return snapshot({ startedAt, now, status: "cancelled", attempts, inputTokens, outputTokens, knownUsageObserved, usageStates });
      }
      const result = response as { text: string; inputTokens?: number; outputTokens?: number };
      const analysis = parsePromptAnalysis(result.text, input.prompt, input.kind);
      if (!analysis) {
        reportAttempt({
          attempt, route: candidate.route, outcome: "malformed",
          usage: usageStates.get(attempt) ?? "unknown",
          ...(tokenCount(result.inputTokens) !== undefined ? { inputTokens: result.inputTokens } : {}),
          ...(tokenCount(result.outputTokens) !== undefined ? { outputTokens: result.outputTokens } : {}),
        });
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
      if (aborted(input.signal) || (error instanceof Error && error.name === "AbortError")) {
        stopped = !settled;
        if (!settled) usageStates.set(attempt, "pending");
        return snapshot({ startedAt, now, status: "cancelled", attempts, inputTokens, outputTokens, knownUsageObserved, usageStates });
      }
      if (!stopped) {
        usageStates.set(attempt, "unknown");
        reportAttempt({ attempt, route: candidate.route, outcome: "failed", usage: "unknown" });
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
