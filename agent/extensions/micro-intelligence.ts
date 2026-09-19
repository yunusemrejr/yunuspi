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
import { resetCoordinator } from "./lib/micro-intelligence/coordinator.ts";
import { microMetrics } from "./lib/micro-intelligence/metrics.ts";
import { microStatusSnapshot } from "./lib/micro-intelligence/status.ts";
import { needleClassify, needleWarmup, needleHandle } from "./lib/needle-runtime.ts";
import { askJev } from "./lib/jev-client.ts";
import { Type } from "typebox";

const HEALTH_SINK = Symbol.for("yunus-pi.health.v1");

function noteHealth(kind: string, data: Record<string, unknown>): void {
  try {
    (globalThis as Record<symbol, unknown>)[HEALTH_SINK]?.(kind, data);
  } catch {
    /* Telemetry is optional. */
  }
}

export interface MicroRequestState {
  deterministic: DeterministicPass;
  needle?: NeedlePass;
  needlePending: boolean;
  advisory?: AdvisoryResult;
  advisoryPending: boolean;
  family: RequestFamily;
  at: number;
}

let lastRequest: MicroRequestState | undefined;

/** Latest request signal for checkpoints (routing, review planning). */
export function lastMicroRequest(): MicroRequestState | undefined {
  return lastRequest;
}

export default function (pi: any) {
  if (process.env.PI_MICRO_INTELLIGENCE === "off") return;

  pi.registerTool({
    name: "micro_status",
    description: "Read-only micro-intelligence status: current request classification, advisory verdict, helper health and utilization. Runs no inference and changes nothing.",
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
            }
          : undefined,
      );
      const text = JSON.stringify(snapshot);
      return { content: [{ type: "text", text }], details: snapshot };
    },
  });

  const reset = () => {
    lastRequest = undefined;
    resetCoordinator();
    microMetrics();
  };

  pi.on("session_start", () => {
    reset();
    // Asynchronous: the worker loads WASM + weights off the critical path.
    try {
      needleWarmup();
    } catch {
      /* Warmup failure degrades to skips; the session is unaffected. */
    }
  });
  pi.on("session_switch", reset);
  pi.on("session_shutdown", () => {
    reset();
    try {
      void needleHandle().shutdown().catch(() => {});
    } catch {
      /* Shutdown is hygiene; the process owns final cleanup. */
    }
  });

  pi.on("before_agent_start", (event: any) => {
    const prompt = typeof event?.prompt === "string" ? event.prompt : "";
    const pass = deterministicRequestPass(prompt);
    const state: MicroRequestState = {
      deterministic: pass,
      needlePending: false,
      advisoryPending: false,
      family: "unknown",
      at: Date.now(),
    };
    lastRequest = state;
    if (!pass.substantive) return;

    // Needle pass: local, fast, never awaited here.
    state.needlePending = true;
    let advisoryStarted = false;
    const startAdvisory = () => {
      if (advisoryStarted || !shouldAdvise(pass, 0)) return;
      advisoryStarted = true;
      state.advisoryPending = true;
      // One compact batched call, consumed at later checkpoints.
      runAdvisory(
        { prompt, family: state.family, terms: pass.terms, candidates: [] },
        (site, advisoryState, questions) => askJev(site, advisoryState, questions, { pi }),
        (advisory) => {
          state.advisoryPending = false;
          state.advisory = advisory;
          if (advisory.ok) {
            noteHealth("ml.request.advisory", {
              decision: advisory.multiPerspective
                ? "council"
                : advisory.reviewWorthy
                  ? "review-worthy"
                  : "routine",
              count: 1,
            });
          }
        },
      );
    };
    // Advisory carries the Needle family when it arrives promptly (500ms);
    // a slow/unavailable Needle never delays the advisory.
    const advisoryTimer = setTimeout(startAdvisory, 500);
    advisoryTimer.unref?.();
    void needleRequestPass(prompt, (text, labels) => needleClassify({ text, labels })).then(
      (needle) => {
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
        state.needlePending = false;
        clearTimeout(advisoryTimer);
        startAdvisory();
      },
    );
  });
}
