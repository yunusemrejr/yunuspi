/** Request-init micro-intelligence: deterministic pass, Needle pass and one
 * compact asynchronous Jev advisory batch per substantive request.
 *
 * Timing contract: nothing here delays provider startup. The deterministic
 * pass is synchronous and cheap; the Needle pass is local and fast; the Jev
 * advisory runs in the background and its result is consumed at later
 * natural checkpoints (routing, review planning, delegation).
 */
import { taskTerms } from "../local-intelligence.mjs";
import { isPromptPivot, isPromptRefusal, isReferentialFollowup } from "../intent-context.ts";
import type { NeedleResult, NeedleClassifyResult } from "../needle-types.ts";
import { microMetrics } from "./metrics.ts";

export type RequestFamily =
  | "implementation" | "investigation" | "review" | "research" | "lookup" | "unknown";

export interface DeterministicPass {
  terms: string[];
  pivot: boolean;
  refusal: boolean;
  followup: boolean;
  chars: number;
  substantive: boolean;
}

export interface NeedlePass {
  family: RequestFamily;
  score: number;
  margin: number;
  accepted: boolean;
}

/** Synchronous deterministic pass over the raw prompt. Pure and total. */
export function deterministicRequestPass(prompt: unknown): DeterministicPass {
  const text = typeof prompt === "string" ? prompt : "";
  const terms = taskTerms(text, 32);
  const pivot = isPromptPivot(text);
  const refusal = isPromptRefusal(text);
  const followup = isReferentialFollowup(text);
  const chars = text.length;
  // Substantive: enough content to classify/route, not a bare stop/pivot cue.
  const substantive = chars >= 40 && terms.length >= 2 && !refusal;
  return { terms, pivot, refusal, followup, chars, substantive };
}

export const REQUEST_FAMILIES: Array<{ id: RequestFamily; text: string }> = [
  { id: "implementation", text: "write, edit, implement, build or fix code, files, configuration or tests" },
  { id: "investigation", text: "debug, diagnose, trace, reproduce or explain a failure, error or unexpected behavior" },
  { id: "review", text: "review, audit, critique or assess code, design, security or quality" },
  { id: "research", text: "research, compare, search the web, gather information or summarize knowledge" },
  { id: "lookup", text: "look up, show, list, read or recall a small known fact, file or value" },
];

export type NeedleClassify = (
  text: string,
  labels: Array<{ id: string; text: string }>,
) => Promise<NeedleResult<NeedleClassifyResult>>;

/** Local semantic request-family classification. Never throws. */
export async function needleRequestPass(
  prompt: string,
  classify: NeedleClassify | undefined,
): Promise<NeedlePass | undefined> {
  const metrics = microMetrics();
  if (!classify || typeof prompt !== "string" || prompt.trim().length < 12) {
    metrics.skip("needle", "trivial");
    return undefined;
  }
  try {
    // 512 chars keeps the background classification inside ~2.5s worst case.
    const result = await classify(prompt.slice(0, 512), REQUEST_FAMILIES);
    if (!result.ok) {
      metrics.skip("needle", result.reason);
      return undefined;
    }
    metrics.run("needle", result.ms);
    metrics.accept("needle");
    const family = (REQUEST_FAMILIES.some((entry) => entry.id === result.value.label)
      ? result.value.label
      : "unknown") as RequestFamily;
    return { family, score: result.value.score, margin: result.value.margin, accepted: result.value.accepted };
  } catch {
    metrics.skip("needle", "unavailable");
    return undefined;
  }
}

export interface AdvisoryContext {
  prompt: string;
  family: RequestFamily;
  terms: string[];
  /** Shortlisted candidate names (tools/workflows/skills), bounded. */
  candidates: string[];
}

export type JevAsk = (
  site: string,
  state: unknown,
  questions: Record<string, unknown>,
) => Promise<
  | { ok: true; answers: Record<string, { choice?: string; noul?: number; probabilities?: Record<string, number> }>; usage: { inputTokens: number; cached: boolean; costUsd?: number } }
  | { ok: false; skipped: string }
>;

export interface AdvisoryResult {
  /** Candidate the judge prefers, when it expresses one confidently. */
  preferred?: string;
  /** True when no shortlisted candidate really fits. */
  noFit: boolean;
  needsVerification: boolean;
  reviewWorthy: boolean;
  /** True when several independent perspectives would materially help. */
  multiPerspective: boolean;
  /** Council/review perspectives worth including, best first. */
  perspectives: string[];
  ok: boolean;
  skipped?: string;
}

export const REVIEW_PERSPECTIVES = [
  "architecture",
  "correctness",
  "security",
  "performance",
  "maintainability",
  "testing",
] as const;

/** Build ONE compact batched advisory question set (<= 7 questions). */
export function buildAdvisoryQuestions(context: AdvisoryContext): Record<string, unknown> {
  const candidates = context.candidates.slice(0, 8);
  const questions: Record<string, unknown> = {
    kind: {
      type: "choice",
      instructions: "Is this request implementation-heavy, investigation-heavy, review-heavy, research-heavy or a small lookup?",
      criteria: {
        implementation: "write, edit, build or fix code, files or tests",
        investigation: "debug, diagnose or explain a failure or behavior",
        review: "review, audit or assess quality or design",
        research: "gather, compare or summarize information",
        lookup: "read or recall a small known fact or file",
      },
    },
    needsVerification: {
      type: "noul",
      instructions: "Does this request require external verification (docs, web, upstream) before acting?",
    },
    reviewWorthy: {
      type: "noul",
      instructions: "Would independent review of the outcome be materially valuable (nontrivial change or judgment)?",
    },
  };
  // Council shaping rides the same batch for work where perspectives matter.
  // Lookup/research requests skip it: one judgment call, no extra round trip.
  if (context.family === "implementation" || context.family === "review" || context.family === "investigation") {
    questions.multiPerspective = {
      type: "noul",
      instructions: "Would several independent perspectives (council) materially improve this over a single review?",
    };
    questions.perspective = {
      type: "choice",
      instructions: "Which review perspective matters most for this request?",
      criteria: {
        architecture: "structure, boundaries, contracts, and design tradeoffs",
        correctness: "logic errors, edge cases, and behavioral regressions",
        security: "authorization, injection, secrets, and trust boundaries",
        performance: "latency, cost, complexity, and resource use",
        maintainability: "clarity, coupling, debt, and future change cost",
        testing: "coverage, verification evidence, and reproducibility",
      },
    };
  }
  if (candidates.length >= 2) {
    questions.fit = {
      type: "choice",
      instructions: "Which shortlisted candidate best fits this request?",
      criteria: Object.fromEntries(candidates.map((name, index) => [`${index}:${name.slice(0, 64)}`, name.slice(0, 128)])),
    };
    questions.noFit = {
      type: "noul",
      instructions: "Do NONE of the shortlisted candidates really fit this request?",
    };
  }
  return questions;
}

/** Gate: substantive, non-pivot requests with something to judge. */
export function shouldAdvise(pass: DeterministicPass, candidateCount: number): boolean {
  if (process.env.PI_MICRO_ADVISORY === "off") return false;
  if (!pass.substantive || pass.pivot) return false;
  return pass.chars >= 60 || candidateCount >= 2;
}

function stateOf(context: AdvisoryContext): unknown {
  return {
    prompt: context.prompt.slice(0, 600),
    family: context.family,
    terms: context.terms.slice(0, 16),
    candidates: context.candidates.slice(0, 8),
  };
}

/**
 * Run the advisory batch asynchronously. Fire-and-forget safe: never throws,
 * never blocks the caller, result is delivered to `consume`. Completed
 * advisories are cached by the coordinator under the caller's key.
 */
export function runAdvisory(
  context: AdvisoryContext,
  ask: JevAsk | undefined,
  consume: (result: AdvisoryResult) => void,
): void {
  const metrics = microMetrics();
  if (!ask) {
    metrics.skip("jev", "disabled");
    return;
  }
  const questions = buildAdvisoryQuestions(context);
  const questionCount = Object.keys(questions).length;
  void (async () => {
    try {
      const judged = await ask("request-advisory", stateOf(context), questions);
      if (!judged.ok) {
        metrics.skip("jev", judged.skipped);
        consume({ noFit: false, needsVerification: false, reviewWorthy: false, multiPerspective: false, perspectives: [], ok: false, skipped: judged.skipped });
        return;
      }
      metrics.run("jev");
      metrics.jevUsage("request-advisory", questionCount, judged.usage.inputTokens, judged.usage.costUsd ?? 0, judged.usage.cached);
      if (judged.usage.cached) metrics.cacheHit("jev");
      metrics.accept("jev");
      const fit = judged.answers.fit?.choice;
      const perspectiveProbs = judged.answers.perspective?.probabilities ?? {};
      const perspectives = Object.entries(perspectiveProbs)
        .sort((a, b) => b[1] - a[1])
        .map(([name]) => name)
        .filter((name) => (REVIEW_PERSPECTIVES as readonly string[]).includes(name))
        .slice(0, 3);
      consume({
        preferred: typeof fit === "string" ? fit.replace(/^\d+:/, "") : undefined,
        noFit: (judged.answers.noFit?.noul ?? 0) >= 0.6,
        needsVerification: (judged.answers.needsVerification?.noul ?? 0) >= 0.6,
        reviewWorthy: (judged.answers.reviewWorthy?.noul ?? 0) >= 0.6,
        multiPerspective: (judged.answers.multiPerspective?.noul ?? 0) >= 0.6,
        perspectives,
        ok: true,
      });
    } catch {
      metrics.skip("jev", "unavailable");
      consume({ noFit: false, needsVerification: false, reviewWorthy: false, multiPerspective: false, perspectives: [], ok: false, skipped: "unavailable" });
    }
  })();
}
