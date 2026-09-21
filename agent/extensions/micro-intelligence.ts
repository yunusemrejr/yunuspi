/**
 * micro-intelligence — session lifecycle for the helper stack.
 *
 * - session start: warm Needle asynchronously, reset the coordination ledger;
 * - every user request: synchronous deterministic pass, local Needle request
 *   classification, and one compact asynchronous Jev advisory batch;
 * - nothing here delays provider startup: Needle/Jev work runs in the
 *   background and later checkpoints consume whatever is ready.
 *
 * This extension owns no authority: routing, eligibility, safety and truth
 * stay with the existing subsystem owners. It only prepares cheap,
 * well-structured signal they can consult.
 */
import {
  deterministicRequestPass,
  needleRequestPass,
  runAdvisory,
  shouldAdvise,
  type AdvisoryResult,
  type DeterministicPass,
  type NeedlePass,
  type RequestFamily,
} from "./lib/micro-intelligence/advisory.ts";
import { microMetrics, resetMicroMetrics } from "./lib/micro-intelligence/metrics.ts";
import { microStatusSnapshot } from "./lib/micro-intelligence/status.ts";
import { needleClassify, needleWarmup, needleHandle } from "./lib/needle-runtime.ts";
import { askJev } from "./lib/jev-client.ts";
import { Type } from "typebox";
import { createHash } from "node:crypto";

const HEALTH_SINK = Symbol.for("yunus-pi.health.v1");

function noteHealth(kind: string, data: Record<string, unknown>): void {
  try {
    (globalThis as Record<symbol, unknown>)[HEALTH_SINK]?.(kind, data);
  } catch {
    /* Telemetry is optional. */
  }
}

export interface MicroRequestState {
  requestHash: string;
  deterministic: DeterministicPass;
  needle?: NeedlePass;
  needlePending: boolean;
  advisory?: AdvisoryResult;
  advisoryPending: boolean;
  family: RequestFamily;
  /** Family actually sent with the advisory batch; the 500ms race means it
   * can lag `family` when Needle arrives after the advisory started. */
  advisoryFamily?: RequestFamily;
  at: number;
}

let lastRequest: MicroRequestState | undefined;

/** Latest request signal for checkpoints (routing, review planning). */
export function lastMicroRequest(): MicroRequestState | undefined {
  return lastRequest;
}

/** Reuse only advice for the exact current task, never an earlier request. */
export function microRequestAdvice(prompt: string): AdvisoryResult | undefined {
  return lastRequest?.requestHash === createHash('sha256').update(prompt).digest('hex') && lastRequest.advisory?.ok ? lastRequest.advisory : undefined;
}

export default function (pi: any, deps = { classify: needleClassify, warmup: needleWarmup, ask: askJev }) {
  if (process.env.PI_MICRO_INTELLIGENCE === "off" || process.env.PI_SUBAGENT_CHILD) return;
  let controller: AbortController | undefined;
  let advisoryTimer: ReturnType<typeof setTimeout> | undefined;

  pi.registerTool({
    name: "micro_status",
    description: "Read-only micro-intelligence status: current request classification, advisory verdict, helper health and utilization. Runs no inference and changes nothing. Jev is a remote OpenRouter advisory; bounded task/request excerpts may be sent there when enabled (PI_JEV=off disables it).",
    parameters: Type.Object({}),
    async execute() {
      const snapshot = microStatusSnapshot(
        lastRequest
          ? {
              family: lastRequest.family,
              substantive: lastRequest.deterministic.substantive,
              terms: lastRequest.deterministic.terms,
              needle: lastRequest.needle,
              needlePending: lastRequest.needlePending,
              advisory: lastRequest.advisory,
              advisoryPending: lastRequest.advisoryPending,
              advisoryFamily: lastRequest.advisoryFamily,
            }
          : undefined,
      );
      const text = JSON.stringify(snapshot);
      return { content: [{ type: "text", text }], details: snapshot };
    },
  });

  const cancel = () => {
    controller?.abort(); controller = undefined;
    clearTimeout(advisoryTimer); advisoryTimer = undefined;
    if (lastRequest) { lastRequest.needlePending = false; lastRequest.advisoryPending = false; }
  };
  const reset = () => {
    cancel();
    lastRequest = undefined;
    microMetrics();
  };

  pi.on("session_start", () => {
    reset();
    resetMicroMetrics();
    // Asynchronous: the worker loads WASM + weights off the critical path.
    try {
      deps.warmup();
    } catch {
      /* Warmup failure degrades to skips; the session is unaffected. */
    }
  });
  for (const event of ['input', 'session_before_switch', 'session_before_fork', 'session_before_tree']) pi.on(event, reset);
  for (const event of ['session_switch', 'session_fork', 'session_tree']) pi.on(event, () => { reset(); resetMicroMetrics(); });
  pi.on('agent_end', cancel);
  pi.on("session_shutdown", () => {
    reset();
    try {
      void needleHandle().shutdown().catch(() => {});
    } catch {
      /* Shutdown is hygiene; the process owns final cleanup. */
    }
  });

  pi.on("before_agent_start", (event: any) => {
    reset();
    const current = new AbortController(); controller = current;
    const isCurrent = () => !current.signal.aborted && controller === current;
    const prompt = typeof event?.prompt === "string" ? event.prompt : "";
    const pass = deterministicRequestPass(prompt);
    const state: MicroRequestState = {
      requestHash: createHash('sha256').update(prompt).digest('hex'),
      deterministic: pass,
      needlePending: false,
      advisoryPending: false,
      family: pass.family,
      at: Date.now(),
    };
    lastRequest = state;
    if (!pass.substantive) return;

    // Needle pass: local, fast, never awaited here.
    state.needlePending = true;
    let advisoryStarted = false;
    const startAdvisory = () => {
      if (!isCurrent() || advisoryStarted || !shouldAdvise(pass, 0)) return;
      advisoryStarted = true;
      state.advisoryPending = true;
      state.advisoryFamily = state.family;
      // One compact batched call, consumed at later checkpoints.
      runAdvisory(
        { prompt, family: state.family, terms: pass.terms, candidates: [] },
        (site, advisoryState, questions) => deps.ask(site, advisoryState, questions, { pi, signal: current.signal }),
        (advisory) => {
          if (!isCurrent()) return;
          state.advisoryPending = false;
          state.advisory = advisory;
          if (advisory.ok) {
            noteHealth("ml.request.advisory", {
              decision: advisory.multiPerspective
                ? "council"
                : advisory.reviewWorthy
                  ? "review-worthy"
                  : "routine",
              family: state.advisoryFamily ?? state.family,
              count: 1,
            });
          }
        },
      );
    };
    // Advisory carries the Needle family when it arrives promptly (500ms);
    // a slow/unavailable Needle never delays the advisory.
    advisoryTimer = setTimeout(startAdvisory, 500);
    advisoryTimer.unref?.();
    void needleRequestPass(prompt, (text, labels) => deps.classify({ text, labels })).then(
      (needle) => {
        if (!isCurrent()) return;
        state.needlePending = false;
        if (needle) {
          state.needle = needle;
          state.family = needle.family;
          noteHealth("ml.request.family", { decision: needle.family, count: 1 });
        }
        clearTimeout(advisoryTimer);
        startAdvisory();
      },
      () => {
        if (!isCurrent()) return;
        state.needlePending = false;
        clearTimeout(advisoryTimer);
        startAdvisory();
      },
    );
  });
}
