import { sessionObservability } from './lib/session-observability.ts';
/** Request-init micro-intelligence and mandatory user-prompt understanding.
 * Only core-provenanced interactive/RPC prompts enter this path. */
import { completeSimple } from "@yunuspi/ai/compat";
import { clampThinkingLevel } from "@yunuspi/ai";
import { Type } from "typebox";
import { Text } from "@yunuspi/tui";
import { createHash } from "node:crypto";
import {
  deterministicRequestPass,
  type AdvisoryResult,
  type DeterministicPass,
  type RequestFamily,
} from "./lib/micro-intelligence/advisory.ts";
import { microMetrics, resetMicroMetrics } from "./lib/micro-intelligence/metrics.ts";
import { microStatusSnapshot } from "./lib/micro-intelligence/status.ts";
import { needleWarmup, needleHandle } from "./lib/needle-runtime.ts";
import { runPromptAnalysis } from "./lib/prompt-analysis-runtime.ts";
import { detectDesignBrief, designDirectionGuidance, designDirectionSummary } from "./lib/design-direction.ts";
import {
  buildPromptAnalysisRequest,
  promptAnalysisEvent,
  promptAnalysisHash,
  renderPromptAnalysis,
  renderPromptAnalysisContext,
  type PromptAnalysis,
  type PromptAnalysisKind,
  type PromptAnalysisPrevious,
} from "./lib/prompt-interpretation.ts";
import type { PromptAnalysisAttempt, PromptAnalysisCandidate } from "./lib/prompt-analysis-runtime.ts";
import { resolvePromptAnalysisPreferenceChain } from "./pi-subagents/src/runs/shared/model-fallback.ts";
import { loadModelEconomyConfig } from "./pi-subagents/src/runs/shared/model-economy.ts";
import { selectAffordableModel } from "./pi-subagents/src/runs/shared/model-selection.ts";
import { findModelInfo, toModelInfo } from "./pi-subagents/src/shared/model-info.ts";
import { capFreeRequest, isProvenFreeRoute } from "./pi-subagents/src/runs/shared/free-route-evidence.ts";

const HEALTH_SINK = Symbol.for("yunus-pi.health.v1");
const PROMPT_ANALYSIS_EVENT = "guardian:prompt-analysis:v1";
const MAX_RETAINED_ANALYSES = 256;
const MAX_RETAINED_ANALYSIS_CHARS = 512 * 1024;
const REQUEST_STATE_REGISTRY = Symbol.for("yunus-pi.micro-request-state.v2");

interface OwnedRequestState { ownerId: string; sessionId: string; state: MicroRequestState; }
function requestStateRegistry(): Map<string, OwnedRequestState> {
  const root = globalThis as typeof globalThis & { [REQUEST_STATE_REGISTRY]?: Map<string, OwnedRequestState> };
  return root[REQUEST_STATE_REGISTRY] ??= new Map();
}
function scopedStates(owner?: string): MicroRequestState[] {
  const entries = [...requestStateRegistry().values()];
  if (owner) {
    const exact = requestStateRegistry().get(owner);
    if (exact) return [exact.state];
    const bySession = entries.filter((entry) => entry.sessionId === owner);
    return bySession.length === 1 ? [bySession[0]!.state] : [];
  }
  return entries.length === 1 ? [entries[0]!.state] : [];
}

function noteHealth(kind: string, data: Record<string, unknown>): void {
  try {
    sessionObservability()[HEALTH_SINK]?.(kind, data);
  } catch {
    /* Telemetry is optional. */
  }
}

export interface MicroRequestState {
  requestHash: string;
  deterministic: DeterministicPass;
  advisory?: AdvisoryResult;
  advisoryPending: boolean;
  family: RequestFamily;
  advisoryFamily?: RequestFamily;
  promptAnalysis?: PromptAnalysis;
  at: number;
}

interface MicroDependencies {
  warmup: typeof needleWarmup;
  completePromptAnalysis?: (model: any, context: any, options: any) => Promise<any>;
}

interface PendingPromptAnalysis {
  ownerId: string;
  requestId: string;
  turnId: string;
  processId: string;
  sessionId: string;
  source: "interactive" | "rpc";
  promptHash: string;
  analysis: PromptAnalysis;
  preferenceSource: "prompt_analysis" | "subagents" | "autonomous";
  route?: string;
  status: "model" | "fallback";
  attempts: PromptAnalysisAttempt[];
  advisory: string;
  /** Design-direction guidance also injected when the analysis fell back. */
  designGuidance: string;
  designSummary: string;
  inputChars: number;
  excerpted: boolean;
  generation: number;
  signal: AbortSignal;
  emitted: boolean;
  displayed: boolean;
  retainedChars: number;
}

/** Read a single unambiguous request state. If multiple sessions are active,
 * callers must name the Guardian owner or session, otherwise this abstains. */
export function lastMicroRequest(owner?: string): MicroRequestState | undefined {
  return scopedStates(owner).at(-1);
}

/** Preserve the checkpoint API while deriving its advisory from the one
 * mandatory prompt-analysis request. The deterministic fallback never
 * masquerades as an ML judgment. */
export function microRequestAdvice(prompt: string, owner?: string): AdvisoryResult | undefined {
  const state = scopedStates(owner).at(-1);
  if (state?.requestHash !== createHash("sha256").update(prompt).digest("hex")) return undefined;
  const analysis = state.promptAnalysis;
  if (!analysis || analysis.source !== "model" || analysis.confidence < 0.65) return undefined;
  return {
    noFit: false,
    needsVerification: analysis.needsExternalVerification,
    reviewWorthy: analysis.reviewWorthy,
    multiPerspective: analysis.multiPerspective,
    perspectives: [],
    ok: true,
  };
}

/** Resume state derived from the transcript. The display message is persisted
 * by the session manager as a `custom_message` entry (customType at the top
 * level); the `message`-wrapped shape is accepted for older transcripts. Its
 * details carry the previous task label, verified constraints and subtasks, so
 * a resumed session can classify the next prompt as a follow-up with real
 * prior context instead of repeating a full initial analysis. */
function priorPromptAnalysisState(ctx: any): {
  seen: boolean;
  previous?: PromptAnalysisPrevious;
} {
  try {
    // Only the active branch belongs to this task; getEntries also includes
    // abandoned branches whose requirements must never become current again.
    const activeEntries = ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.();
    const entries = Array.isArray(activeEntries) ? activeEntries : [];
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry: any = entries[index];
      const isAnalysis = (entry?.type === "custom_message" && entry.customType === "prompt-analysis")
        || (entry?.type === "message" && entry.message?.role === "custom" && entry.message?.customType === "prompt-analysis");
      if (!isAnalysis) continue;
      const details: any = entry.details ?? entry.message?.details ?? {};
      const constraints: PromptAnalysis["explicitConstraints"] = Array.isArray(details.explicitConstraints)
        ? details.explicitConstraints
            .filter((item: any) => item && typeof item.text === "string" && item.text && item.source === "literal-user"
              && item.quoted !== true && Number.isInteger(item.start) && Number.isInteger(item.end))
            .slice(0, 6)
            .map((item: any) => ({ text: item.text.slice(0, 180), source: "literal-user" as const, start: item.start, end: item.end, quoted: false }))
        : [];
      const subtasks = Array.isArray(details.subtasks)
        ? details.subtasks.filter((item: any) => typeof item === "string" && item).slice(0, 5)
        : [];
      return {
        seen: true,
        previous: {
          taskLabel: typeof details.taskLabel === "string" ? details.taskLabel.slice(0, 180) : "",
          explicitConstraints: constraints,
          subtasks,
        },
      };
    }
  } catch {
    /* Resume context is advisory; a damaged transcript simply starts fresh. */
  }
  return { seen: false };
}

function promptAnalysisAdvice(analysis: PromptAnalysis): AdvisoryResult | undefined {
  if (analysis.source !== "model" || analysis.confidence < 0.65) return undefined;
  return {
    noFit: false,
    needsVerification: analysis.needsExternalVerification,
    reviewWorthy: analysis.reviewWorthy,
    multiPerspective: analysis.multiPerspective,
    perspectives: [],
    ok: true,
  };
}

interface AnalysisSelection {
  source: PendingPromptAnalysis["preferenceSource"];
  routes: PromptAnalysisCandidate[];
}

function toText(response: any): string {
  if (!Array.isArray(response?.content)) return "";
  return response.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .trim();
}

function tokens(response: any, direction: "input" | "output"): number | undefined {
  const value = response?.usage?.[direction] ?? response?.usage?.[direction === "input" ? "inputTokens" : "outputTokens"];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function scopedRouteSet(ctx: any): Set<string> | undefined {
  if (!Array.isArray(ctx.scopedModels) || ctx.scopedModels.length === 0) return undefined;
  const routes = ctx.scopedModels.map((entry: any) => {
    const model = entry?.model;
    return typeof model?.provider === "string" && typeof model?.id === "string"
      ? `${model.provider}/${model.id}`
      : undefined;
  }).filter((route: unknown): route is string => typeof route === "string");
  return new Set(routes);
}

function analysisCandidates(
  ctx: any,
  prompt: string,
  kind: PromptAnalysisKind,
  metrics: ReturnType<typeof microMetrics>,
  completePromptAnalysis: MicroDependencies["completePromptAnalysis"],
): AnalysisSelection {
  try {
    const scope = scopedRouteSet(ctx);
    const available = ctx.modelRegistry.getAvailable();
    const models = available.filter((model: any) => !scope || scope.has(`${model.provider}/${model.id}`));
    const modelInfos = models.map(toModelInfo);
    const maxOutputTokens = kind === "initial" ? 768 : 320;
    const request = buildPromptAnalysisRequest(prompt, kind);
    const minContextWindow = Math.max(8192, Math.ceil(request.length / 4) + maxOutputTokens + 1024);
    const options = {
      requirements: { inputModalities: ["text"], minContextWindow, minOutputTokens: maxOutputTokens },
    };
    const preference = resolvePromptAnalysisPreferenceChain(modelInfos, options);
    const resolved: Array<{ route: string; model: any; thinking?: string; providerRouting?: Record<string, unknown> }> = [];
    const add = (route: string, thinking?: string, providerRouting?: Record<string, unknown>) => {
      const info = findModelInfo(route, modelInfos);
      if (!info) return;
      const model = ctx.modelRegistry.find(info.provider, info.id);
      if (!model) return;
      if (resolved.some((entry) => entry.route === route && entry.thinking === thinking)) return;
      resolved.push({ route, model, ...(thinking ? { thinking } : {}), ...(providerRouting ? { providerRouting } : {}) });
    };

    // Honor the configured Prompt Analysis route chain (or inherited
    // Subagents chain) in its existing order. Explicit preferences are the
    // user's route choice and therefore are not silently reordered by cost.
    for (const preferred of preference.routes) {
      add(preferred.route, preferred.thinking, preferred.providerRouting);
    }
    if (resolved.length) {
      return { source: preference.source, routes: resolved.map((entry) => makeCandidate(entry, ctx, metrics, completePromptAnalysis)) };
    }

    // With no usable configured route, use the existing offline economy
    // selector under a per-request estimated spend cap. This selection is
    // bounded by declared pricing; the current primary model is never an
    // implicit expensive fallback.
    const maxEstimatedUsd = kind === "initial" ? 0.01 : 0.003;
    const estimatedInputTokens = Math.ceil(request.length / 2);
    // Admission includes the largest supported reasoning reserve and the
    // compact recovery answer allowance, not only visible JSON tokens.
    const estimatedCostTokens = estimatedInputTokens + maxOutputTokens * 2 + 8192;
    const requestRateCap = maxEstimatedUsd * 1_000_000 / estimatedCostTokens;
    const configuredEconomy = loadModelEconomyConfig();
    const boundedEconomy = {
      ...configuredEconomy,
      maxInputPerMillion: Math.min(configuredEconomy.maxInputPerMillion, requestRateCap),
      maxOutputPerMillion: Math.min(configuredEconomy.maxOutputPerMillion, requestRateCap),
      operationalPremiumMaxPerMillion: undefined,
    };
    const excluded: string[] = [];
    for (let index = 0; index < 4; index++) {
      const selected = selectAffordableModel(modelInfos, boundedEconomy, {
        exclude: excluded,
        decision: { preferenceRole: "prompt_analysis" },
        requirements: { minContextWindow: 8192, minOutputTokens: maxOutputTokens, reasoning: false, inputModalities: ["text"], toolCalling: false },
      });
      if (!selected) break;
      add(selected.model);
      excluded.push(selected.model);
    }
    return { source: "autonomous", routes: resolved.map((entry) => makeCandidate(entry, ctx, metrics, completePromptAnalysis)) };
  } catch {
    return { source: "autonomous", routes: [] };
  }
}

function makeCandidate(
  entry: { route: string; model: any; thinking?: string; providerRouting?: Record<string, unknown> },
  ctx: any,
  metrics: ReturnType<typeof microMetrics>,
  completePromptAnalysis: MicroDependencies["completePromptAnalysis"],
): PromptAnalysisCandidate {
  // This direct SDK request does not pass through the agent's provider hooks.
  // Retain the admission-time free obligation across asynchronous auth, then
  // revalidate the actual wire model and current price evidence before dispatch.
  const requireFreeDispatch = isProvenFreeRoute(entry.model);
  return {
    route: entry.route,
    complete: async ({ prompt: analysisPrompt, maxTokens, signal }) => {
      if (signal.aborted) throw new Error("Prompt analysis cancelled");
      const routedModel = entry.providerRouting
        ? { ...entry.model, compat: { ...(entry.model.compat ?? {}), openRouterRouting: entry.providerRouting } }
        : entry.model;
      const context = { messages: [{ role: "user", content: [{ type: "text", text: analysisPrompt }], timestamp: Date.now() }] };
      // Some providers cannot turn reasoning off. Their reasoning and answer
      // share maxTokens, so reserve answer room instead of exhausting the
      // entire tiny JSON allowance before the first answer token.
      const reasoning = clampThinkingLevel(entry.model, (entry.thinking ?? "off") as any);
      const reasoningAllowance = reasoning === "off" ? 0 : reasoning === "minimal" ? 2048 : reasoning === "low" ? 4096 : 8192;
      const options = { maxTokens: Math.min(entry.model.maxTokens || 32768, maxTokens + reasoningAllowance), signal, ...(reasoning === "off" ? {} : { reasoning }), maxRetries: 0,
        ...(requireFreeDispatch ? { onPayload: (payload: Record<string, any>, model: any) => {
          if (model?.provider !== entry.model.provider || model?.id !== entry.model.id)
            throw Object.assign(new Error("Prompt analysis free route changed before dispatch"), { code: "PI_AUTONOMOUS_REQUEST_DENIED" });
          return capFreeRequest(payload, model);
        } } : {}),
      };
      // The registry owns native provider dispatch, OAuth/base URL overrides
      // and auth cancellation. Using the global compatibility API bypasses
      // providers registered by this session. Keep a legacy adapter for older
      // extension hosts and the narrow completion seam used by unit fixtures.
      if (!completePromptAnalysis && typeof ctx.modelRegistry.completeSimple === "function") {
        metrics.llmHelperCall();
        const response = await ctx.modelRegistry.completeSimple(routedModel, context, options);
        if (response?.stopReason === "error") throw new Error(response.errorMessage || "Prompt analysis model request failed");
        // An aborted stream is the timeout/cancel echo, not a late completion.
        if (response?.stopReason === "aborted") throw Object.assign(new Error("Prompt analysis request aborted"), { name: "AbortError" });
        return { text: toText(response), stopReason: response.stopReason, reasoningTokens: response.usage?.reasoning, inputTokens: tokens(response, "input"), outputTokens: tokens(response, "output") };
      }
      const authRequest = Promise.resolve(ctx.modelRegistry.getApiKeyAndHeaders(entry.model));
      let onAbort: (() => void) | undefined;
      const auth = await Promise.race([
        authRequest,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(Object.assign(new Error("Prompt analysis cancelled"), { name: "AbortError" }));
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]).finally(() => { if (onAbort) signal.removeEventListener("abort", onAbort); });
      if (signal.aborted) throw new Error("Prompt analysis cancelled");
      if (!auth || auth.ok === false) throw new Error(auth?.error || "Model route authentication unavailable");
      const model = auth.baseUrl ? { ...routedModel, baseUrl: auth.baseUrl } : routedModel;
      metrics.llmHelperCall();
      const response: any = await (completePromptAnalysis ?? completeSimple)(model, context, {
        apiKey: auth.apiKey,
        headers: auth.headers,
        env: auth.env,
        ...options,
      });
      if (response?.stopReason === "error") throw new Error(response.errorMessage || "Prompt analysis model request failed");
      if (response?.stopReason === "aborted") throw Object.assign(new Error("Prompt analysis request aborted"), { name: "AbortError" });
      return { text: toText(response), stopReason: response?.stopReason, reasoningTokens: response?.usage?.reasoning, inputTokens: tokens(response, "input"), outputTokens: tokens(response, "output") };
    },
  };
}

function analysisDetails(pending: PendingPromptAnalysis, source: string) {
  return {
    version: 1,
    requestId: pending.requestId,
    promptHash: pending.promptHash,
    turnId: pending.turnId,
    processId: pending.processId,
    sessionId: pending.sessionId,
    kind: pending.analysis.kind,
    source,
    status: pending.status,
    attempts: pending.attempts,
    ...(pending.advisory ? { advisory: pending.advisory } : {}),
    inputChars: pending.inputChars,
    excerpted: pending.excerpted,
    confidence: pending.analysis.confidence,
    taskLabel: pending.analysis.taskLabel,
    intent: pending.analysis.intent,
    secondaryIntents: pending.analysis.secondaryIntents.slice(0, 8),
    deliverables: pending.analysis.deliverables.slice(0, 8),
    explicitConstraints: pending.analysis.explicitConstraints.slice(0, 12),
    inferredConstraints: pending.analysis.inferredConstraints.slice(0, 8),
    subtasks: pending.analysis.subtasks.slice(0, 8),
    dependencies: pending.analysis.dependencies.slice(0, 8),
    references: pending.analysis.references.slice(0, 8),
    suggestedCapabilities: pending.analysis.suggestedCapabilities.slice(0, 8),
    expectedTools: pending.analysis.expectedTools.slice(0, 8),
    expectedSkills: pending.analysis.expectedSkills.slice(0, 8),
    completionConditions: pending.analysis.completionConditions.slice(0, 8),
    ambiguities: pending.analysis.ambiguities.slice(0, 8),
    relation: pending.analysis.relation,
  };
}

export default function (pi: any, deps: MicroDependencies = { warmup: needleWarmup }) {
  if (process.env.PI_MICRO_INTELLIGENCE === "off" || process.env.PI_SUBAGENT_CHILD === "1") return;
  let lastRequest: MicroRequestState | undefined;
  let generation = 0;
  let activeSessionId = "";
  let activeOwnerId = "";
  let sessionController = new AbortController();
  let initialPromptSeen = false;
  /** Prior-task summary restored from the transcript on resume, so the first
   * post-resume prompt is classified with real context. */
  let resumedAnalysisContext: PromptAnalysisPrevious | undefined;
  let preflightChain: Promise<void> = Promise.resolve();
  const pendingContext = new Map<string, PendingPromptAnalysis>();
  /** Requests whose advisory may currently be injected, and the requests seen
   * in the previous context pass. Together they bound the injected advisory to
   * the newest user request instead of every request in the session. */
  let activeAdvisoryRequestIds = new Set<string>();
  let knownPendingRequestIds = new Set<string>();
  let retainedAnalysisChars = 0;
  let clearAnalysisProgress: (() => void) | undefined;

  pi.registerMessageRenderer?.("prompt-analysis", (message: any, { expanded }: { expanded: boolean }) => {
    const summary = typeof message.content === "string" ? message.content : "Intent analysis";
    // A fallback sends at most local design-direction guidance; nothing else to expand.
    const advisory = message.details?.advisory;
    return new Text(summary + (typeof advisory === "string" && advisory
      ? expanded ? `\n\nExact advisory sent to the main agent:\n${advisory}` : "\nExpand to see the exact advisory sent to the main agent."
      : ""), 0, 0);
  });

  pi.registerTool({
    name: "micro_status",
    description: "Read-only micro-intelligence status: current request classification, prompt-analysis status, helper health and utilization. Runs no inference and changes nothing.",
    parameters: Type.Object({}),
    async execute() {
      const request = lastRequest
        ? {
            family: lastRequest.family,
            substantive: lastRequest.deterministic.substantive,
            terms: lastRequest.deterministic.terms,
            advisory: lastRequest.advisory,
            advisoryPending: lastRequest.advisoryPending,
            advisoryFamily: lastRequest.advisoryFamily,
            promptAnalysis: lastRequest.promptAnalysis ? {
              kind: lastRequest.promptAnalysis.kind,
              source: lastRequest.promptAnalysis.source,
              confidence: lastRequest.promptAnalysis.confidence,
              taskLabel: lastRequest.promptAnalysis.taskLabel,
            } : undefined,
          }
        : undefined;
      const snapshot = microStatusSnapshot(request);
      const text = JSON.stringify(snapshot);
      return { content: [{ type: "text", text }], details: snapshot };
    },
  });

  const reset = (ctx?: any, reason?: string) => {
    clearAnalysisProgress?.();
    clearAnalysisProgress = undefined;
    sessionController.abort(new Error("Prompt-analysis session owner changed"));
    sessionController = new AbortController();
    generation++;
    if (activeOwnerId) requestStateRegistry().delete(activeOwnerId);
    pendingContext.clear();
    retainedAnalysisChars = 0;
    activeAdvisoryRequestIds = new Set();
    knownPendingRequestIds = new Set();
    lastRequest = undefined;
    const resumed = reason === "new" ? { seen: false } : priorPromptAnalysisState(ctx);
    initialPromptSeen = resumed.seen;
    resumedAnalysisContext = resumed.previous;
    activeSessionId = typeof ctx?.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : "";
    activeOwnerId = "";
  };

  pi.on("session_start", (event: any, ctx: any) => {
    reset(ctx, event?.reason);
    try { ctx.ui?.setStatus?.("prompt-analysis", undefined); } catch { /* optional UI */ }
    resetMicroMetrics();
    try { deps.warmup(); } catch { /* warmup is optional */ }
  });
  // before_* events are cancellable. Reset only once the operation commits or
  // the old runtime shuts down; a veto must preserve the current task state.
  pi.on("session_tree", (_event: any, ctx: any) => {
    reset(ctx, "resume");
    try { ctx.ui?.setStatus?.("prompt-analysis", undefined); } catch { /* optional UI */ }
    resetMicroMetrics();
  });
  pi.on("session_shutdown", () => {
    reset();
    try { void needleHandle().shutdown().catch(() => {}); } catch { /* Shutdown is hygiene. */ }
  });

  pi.on("input", async (event: any, ctx: any) => {
    // Core source is authoritative: user-role API messages with source=extension,
    // reminders, child assignments and other synthetic inputs stay excluded.
    if (event?.source !== "interactive" && event?.source !== "rpc") return;
    const rawPrompt = typeof event.originalText === "string" ? event.originalText : undefined;
    if (!rawPrompt?.trim() || event.signal?.aborted) return;
    if (typeof event.requestId !== "string" || !event.requestId || typeof event.turnId !== "string" || !event.turnId
      || typeof event.sessionId !== "string" || !event.sessionId || typeof event.processId !== "string" || !event.processId
      || typeof event.guardianOwnerId !== "string" || !event.guardianOwnerId) {
      noteHealth("ml.prompt.analysis", { decision: "missing-provenance", count: 1 });
      return;
    }
    const arrivalGeneration = generation;
    const arrivalSessionId = activeSessionId;
    const arrivalOwnerId = activeOwnerId;
    const eventSessionId = event.sessionId as string;
    const guardianOwnerId = event.guardianOwnerId as string;

    // Core also serializes preflight, but retain arrival ordering when older
    // callers or test harnesses invoke input handlers concurrently.
    const previousPreflight = preflightChain;
    let releasePreflight!: () => void;
    preflightChain = new Promise<void>((resolve) => { releasePreflight = resolve; });
    await previousPreflight;
    try {
      // A session switch/disposal can happen while this input waits behind an
      // earlier analysis. Never let an aborted queued request reset the new
      // session's state or publish stale metadata.
      if (event.signal?.aborted) return;
      const liveSessionId = typeof ctx.sessionManager?.getSessionId === "function" ? ctx.sessionManager.getSessionId() : "";
      if (liveSessionId && liveSessionId !== eventSessionId) return;
      if (generation !== arrivalGeneration && arrivalSessionId === eventSessionId && arrivalOwnerId === guardianOwnerId) return;
      const prompt = rawPrompt;
      const sessionId = eventSessionId;
      if (activeSessionId && sessionId !== activeSessionId) reset(ctx, "new");
      activeSessionId = sessionId;
      activeOwnerId = guardianOwnerId;
      const currentGeneration = generation;
      const sessionSignal = sessionController.signal;
      const signal = event.signal ? AbortSignal.any([sessionSignal, event.signal]) : sessionSignal;
      const owns = () => currentGeneration === generation && activeSessionId === sessionId && !signal.aborted;
      if (!owns()) return;

      // Preflight may finish analysis and then be rejected by a later hook,
      // auth validation or cancellation. Such requests are not prior tasks.
      const validPrior = [...pendingContext.values()].filter((entry) => !entry.signal.aborted);
      const priorAnalysis = validPrior.at(-1)?.analysis;
      // Keep the first accepted task and a bounded recent history visible.
      // Otherwise A -> small addition B -> correction C sees only B and loses
      // A's unaffected constraints before the helper can classify C.
      const history = [...new Set([validPrior[0], ...validPrior.slice(-5)])]
        .filter((entry): entry is PendingPromptAnalysis => !!entry)
        .map(({ analysis }) => ({ taskLabel: analysis.taskLabel, explicitConstraints: analysis.explicitConstraints, subtasks: analysis.subtasks }));
      const kind: PromptAnalysisKind = priorAnalysis || initialPromptSeen ? "followup" : "initial";
      const deterministic = deterministicRequestPass(prompt);
      const metrics = microMetrics();
      metrics.offer("llm");
      const state: MicroRequestState = {
        requestHash: createHash("sha256").update(prompt).digest("hex"),
        deterministic,
        advisoryPending: true,
        family: deterministic.family,
        at: Date.now(),
      };
      lastRequest = state;
      requestStateRegistry().set(guardianOwnerId, { ownerId: guardianOwnerId, sessionId, state });
      while (requestStateRegistry().size > 128) {
        const oldest = requestStateRegistry().keys().next().value;
        if (oldest === undefined) break;
        requestStateRegistry().delete(oldest);
      }

      // Request family comes from deterministic cues and prompt analysis.
      // Needle zero-shot family classification was removed: on 20 recorded
      // prompts it agreed with the cues once, mislabelled fixes as lookups,
      // never cleared its 0.02 margin (max 0.009), and occupied the serial
      // Needle worker at the moment tool and skill ranking needed it.

      const selected = analysisCandidates(ctx, prompt, kind, metrics, deps.completePromptAnalysis);
      const attempts: PromptAnalysisAttempt[] = [];
      let progress: { attempt: number; route: string; recovery?: string; startedAt: number; timeoutMs: number } | undefined;
      const showProgress = () => {
        try { if (owns() && progress) ctx.ui?.setStatus?.("prompt-analysis", `Intent analysis · ${progress.route} · attempt ${progress.attempt}${progress.recovery ? " · compact retry" : ""} · ${Math.floor((Date.now() - progress.startedAt) / 1000)}s / ${Math.ceil(progress.timeoutMs / 1000)}s allowed`); } catch { /* UI must not stop analysis */ }
      };
      const progressTimer = setInterval(showProgress, 1000);
      const clearProgress = () => {
        clearInterval(progressTimer);
        try { ctx.ui?.setStatus?.("prompt-analysis", undefined); } catch { /* optional UI */ }
      };
      clearAnalysisProgress = clearProgress;
      const result = await runPromptAnalysis({
        prompt,
        kind,
        previous: priorAnalysis ? {
          taskLabel: priorAnalysis.taskLabel,
          explicitConstraints: priorAnalysis.explicitConstraints,
          subtasks: priorAnalysis.subtasks,
          history: resumedAnalysisContext ? [resumedAnalysisContext, ...history].slice(-6) : history,
        } : resumedAnalysisContext,
        candidates: selected.routes,
        signal,
        onStart: detail => { progress = { ...detail, startedAt: Date.now() }; showProgress(); },
        onAttempt: (attempt) => {
          if (!owns()) return;
          // Keep the bounded initial outcome for the visible explanation;
          // late usage reconciliation cannot turn a timeout into success.
          if (!attempt.outcome.startsWith("late-")) attempts.push({ ...attempt });
          noteHealth("ml.prompt.analysis.attempt", {
            requestId: event.requestId,
            route: attempt.route,
            decision: attempt.outcome,
            outcome: attempt.outcome,
            usage: attempt.usage,
            attempt: attempt.attempt,
            ...(attempt.inputTokens !== undefined ? { inputTokens: attempt.inputTokens } : {}),
            ...(attempt.outputTokens !== undefined ? { outputTokens: attempt.outputTokens } : {}),
            count: 1,
            ...(attempt.failureCategory ? { reason: attempt.failureCategory } : {}),
            ...(attempt.reasoningTokens !== undefined ? { reasoningTokens: attempt.reasoningTokens } : {}),
          });
        },
      }).finally(() => {
        clearInterval(progressTimer);
        if (clearAnalysisProgress === clearProgress) { clearProgress(); clearAnalysisProgress = undefined; }
      });
      if (!owns() || result.status === "cancelled" || !result.analysis) {
        if (currentGeneration === generation && activeOwnerId === guardianOwnerId && lastRequest === state) {
          state.advisoryPending = false;
          requestStateRegistry().set(guardianOwnerId, { ownerId: guardianOwnerId, sessionId, state });
        }
        metrics.skip("llm", result.status === "cancelled" ? "cancelled" : "unavailable");
        return;
      }
      const analysis = result.analysis;
      state.promptAnalysis = analysis;
      state.advisory = promptAnalysisAdvice(analysis);
      state.advisoryPending = false;
      state.advisoryFamily = state.family;
      if (result.status === "model") metrics.accept("llm");

      // Open-ended or visual briefs get the divergence protocol; incidental
      // references are marked context-only so they cannot become templates.
      // Follow-ups inherit the scope, so only the first request qualifies
      // unless the follow-up itself starts new visual work.
      const designBrief = detectDesignBrief(prompt, kind === "initial" || analysis.visualDesign ? analysis : { ...analysis, source: "model", visualDesign: false, openEnded: false });
      const designGuidance = designDirectionGuidance(designBrief);
      const pending: PendingPromptAnalysis = {
        ownerId: guardianOwnerId,
        requestId: event.requestId,
        turnId: event.turnId,
        processId: event.processId,
        sessionId,
        source: event.source,
        promptHash: promptAnalysisHash(prompt),
        analysis,
        preferenceSource: selected.source,
        ...(result.route ? { route: result.route } : {}),
        status: result.status,
        attempts,
        advisory: result.status === "fallback"
          ? designGuidance
          : [renderPromptAnalysisContext(analysis, selected.source, result.route), designGuidance].filter(Boolean).join("\n"),
        designGuidance,
        designSummary: designDirectionSummary(designBrief),
        inputChars: prompt.length,
        excerpted: prompt.length > (kind === "initial" ? 24_000 : 8_000),
        generation: currentGeneration,
        signal,
        emitted: false,
        displayed: false,
        retainedChars: 0,
      };
      const previousPending = pendingContext.get(pending.requestId);
      if (previousPending) retainedAnalysisChars -= previousPending.retainedChars;
      pending.retainedChars = JSON.stringify(analysis).length + pending.advisory.length;
      pendingContext.set(pending.requestId, pending);
      retainedAnalysisChars += pending.retainedChars;
      while (pendingContext.size > MAX_RETAINED_ANALYSES || retainedAnalysisChars > MAX_RETAINED_ANALYSIS_CHARS) {
        const oldest = pendingContext.keys().next().value;
        if (oldest === undefined) break;
        retainedAnalysisChars -= pendingContext.get(oldest)?.retainedChars ?? 0;
        pendingContext.delete(oldest);
      }
      noteHealth("ml.prompt.analysis", {
        route: result.route ?? "none",
        owner: selected.source,
        decision: result.status,
        durationMs: result.durationMs,
        ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
        ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
        usageUnknownAttempts: result.usageUnknownAttempts,
        usagePendingAttempts: result.usagePendingAttempts,
        count: 1,
      });
    } finally {
      releasePreflight();
    }
  });

  pi.on("context", async (event: any, ctx: any) => {
    if (!Array.isArray(event?.messages) || !Array.isArray(event.requestMessages) || ctx.signal?.aborted) return;
    const next = [...event.messages];
    const inserts: Array<{ index: number; message: any }> = [];
    const matching = [...event.requestMessages]
      .filter((request: any) => request && typeof request.requestId === "string" && Number.isSafeInteger(request.messageIndex))
      .sort((a: any, b: any) => a.messageIndex - b.messageIndex);
    const pendingFor = (request: any) => {
      const pending = pendingContext.get(request.requestId);
      if (!pending || pending.ownerId !== activeOwnerId || pending.generation !== generation
        || pending.sessionId !== activeSessionId || pending.turnId !== request.turnId
        || pending.signal.aborted || ctx.signal?.aborted) return undefined;
      const userMessage = event.messages[request.messageIndex];
      if (!userMessage || userMessage.role !== "user") return undefined;
      return pending;
    };
    const seen = new Set<string>();
    const eligible: Array<{ request: any; pending: PendingPromptAnalysis }> = [];
    for (const request of matching) {
      if (seen.has(request.requestId)) continue;
      seen.add(request.requestId);
      const pending = pendingFor(request);
      if (pending) eligible.push({ request, pending });
    }
    // Every historical user message keeps its Guardian request provenance, so
    // this payload names all of them while transform output is never persisted.
    // A newly arrived user request opens a fresh advisory window; re-passes of
    // the same payload keep it, so a multi-request turn stays annotated without
    // carrying every earlier turn's interpretation forward forever.
    const knownIds = new Set(matching.map((request: any) => request.requestId));
    const arrival = matching.filter((request: any) => !knownPendingRequestIds.has(request.requestId));
    if (arrival.length) activeAdvisoryRequestIds = new Set(arrival.map((request: any) => request.requestId));
    knownPendingRequestIds = knownIds;
    for (const id of [...activeAdvisoryRequestIds]) if (!knownIds.has(id)) activeAdvisoryRequestIds.delete(id);
    for (const { request, pending } of eligible) {
      const requestAlreadyPresent = event.messages.some((message: any) =>
        message?.role === "custom" && message.customType === "prompt-analysis-context" && message.details?.requestId === pending.requestId,
      );
      // A deterministic fallback only restates the literal prompt with zero
      // confidence; injecting it would spend context on no new information.
      if ((pending.status !== "fallback" || pending.designGuidance) && pending.advisory && !requestAlreadyPresent && activeAdvisoryRequestIds.has(request.requestId)) {
        const details = analysisDetails(pending, pending.preferenceSource);
        const content = pending.advisory;
        inserts.push({
          index: request.messageIndex,
          message: {
            role: "custom",
            customType: "prompt-analysis-context",
            content: [{ type: "text", text: `${content}\nRequest identity: ${pending.requestId}. This interpretation is advisory; use the literal user prompt as authority.` }],
            display: false,
            details,
            timestamp: Date.now(),
          },
        });
      }

      if (!pending.emitted && !pending.signal.aborted && !ctx.signal?.aborted) {
        const typedEvent = promptAnalysisEvent({
          processId: pending.processId,
          sessionId: pending.sessionId,
          turnId: pending.turnId,
          requestId: pending.requestId,
          promptHash: pending.promptHash,
          analysis: pending.analysis,
          inputSource: pending.source,
        });
        pending.emitted = true;
        try { pi.events?.emit(PROMPT_ANALYSIS_EVENT, { ...typedEvent, guardianOwnerId: pending.ownerId }); } catch { /* Guardian event bridge is optional. */ }
      }

      if (!pending.displayed && !pending.signal.aborted && !ctx.signal?.aborted) {
        pending.displayed = true;
        const reasons = pending.attempts.map((attempt) => `${attempt.route} ${attempt.outcome === "timeout" && attempt.timeoutMs ? `timed out after ${(attempt.timeoutMs / 1000).toFixed(1)}s` : attempt.outcome === "truncated" ? `output limit reached${attempt.reasoningTokens ? ` (${attempt.reasoningTokens} reasoning tokens)` : ""}` : attempt.outcome === "empty" ? "returned no answer" : attempt.outcome}${attempt.recovery ? "; retrying with compact response" : ""}${attempt.failureCategory ? ` (${attempt.failureCategory})` : ""}`);
        const concise = pending.status === "fallback" ? [
          `Intent analysis · ${pending.analysis.kind} · unavailable — ${reasons.join("; ") || "no eligible analysis route"}.`,
          pending.designGuidance
            ? "Only design-direction guidance (from local rules) was added to the main agent's context; it works from your prompt as written."
            : "Nothing was added to the main agent's context; it works from your prompt as written.",
          ...(pending.designSummary ? [pending.designSummary] : []),
        ].join("\n") : [
          renderPromptAnalysis(pending.analysis, pending.preferenceSource, pending.route),
          ...(pending.analysis.kind === "followup" && !pending.analysis.relation ? ["Relationship: uncertain; earlier user scope remains authoritative."] : []),
          ...(reasons.length > 1 ? [`Routes: ${reasons.join("; ")}.`] : []),
          ...(pending.excerpted ? ["Long request: analysis used the beginning, end and extracted task focus; the omitted middle may contain additional constraints."] : []),
          ...(pending.designSummary ? [pending.designSummary] : []),
          "Original user prompt preserved. This advisory informs the main agent; it does not replace the request.",
        ].join("\n");
        const details = analysisDetails(pending, pending.preferenceSource);
        try {
          await pi.sendMessage({
            customType: "prompt-analysis",
            content: concise,
            display: true,
            details: { ...details, promptHash: pending.promptHash },
            excludeFromContext: true,
          }, { triggerTurn: false });
        } catch {
          // The send did not display this advisory. Allow a later context pass
          // to retry it, while retaining the in-flight guard above.
          if (pendingFor(request) === pending) pending.displayed = false;
        }
      }
    }
    // A session switch or request abort can occur during the display await.
    // The native context runner accepts this return value after the await, so
    // recheck ownership before returning any prepared advisory messages.
    if (eligible.some(({ request, pending }) => pendingFor(request) !== pending)) return undefined;
    for (const insert of inserts.reverse()) next.splice(insert.index + 1, 0, insert.message);
    return inserts.length ? { messages: next } : undefined;
  });
}
