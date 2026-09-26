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
import { microMetrics } from "./metrics.ts";
import { COUNCIL_PERSPECTIVES } from "./review.ts";
import { requestExcerpt } from '../prompt-interpretation.ts';

export type RequestFamily =
  | "implementation" | "investigation" | "review" | "research" | "lookup" | "unknown";

export interface DeterministicPass {
  family: RequestFamily;
  terms: string[];
  pivot: boolean;
  refusal: boolean;
  followup: boolean;
  chars: number;
  substantive: boolean;
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
  // This is a cheap advisory prior, never a mutation/authorization decision.
  // Everyday change verbs (make, remove, update, turn ... into) count: 9 of 20
  // recorded prompts were otherwise "unknown".
  const cues = text.slice(0, 8192).replace(/```[\s\S]*?```/g, ' ').replace(/^\s*>.*$/gm, ' ');
  const family: RequestFamily = /\b(?:implement|build|fix|refactor|add|edit|create|improve|optimi[sz]e|make|remove|delete|update|upgrade|change|convert|turn|replace|rewrite|redesign|migrate|port|install|deploy|write|generate|integrate|deslopify)\b/i.test(cues) ? 'implementation'
    : /\b(?:review|audit|critique|assess)\b/i.test(cues) ? 'review'
    : /\b(?:debug|diagnose|trace|reproduce|investigate|understand|analy[sz]e|inspect|explore)\b/i.test(cues) ? 'investigation'
    : /\b(?:research|compare|search|summarize)\b/i.test(cues) ? 'research'
    : /\b(?:show|list|read|recall|look up)\b/i.test(cues) ? 'lookup' : 'unknown';
  return { terms, pivot, refusal, followup, chars, substantive, family };
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

/** Single council-perspective vocabulary, shared with the review helpers and
 * the scope-council focus cue; a second list here would drift silently. */
export const REVIEW_PERSPECTIVES: readonly string[] = COUNCIL_PERSPECTIVES.map((entry) => entry.id);

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
      criteria: Object.fromEntries(COUNCIL_PERSPECTIVES.map((entry) => [entry.id, entry.text])),
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
    prompt: requestExcerpt(context.prompt, 1600),
    family: context.family,
    terms: context.terms.slice(0, 16),
    candidates: context.candidates.slice(0, 8),
  };
}

/**
 * Run the advisory batch asynchronously. Fire-and-forget safe: never throws,
 * never blocks the caller, result is delivered to `consume`. Completed
 * advisories are deduplicated and cached by the Jev client by exact input.
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
      metrics.jevUsage("request-advisory", questionCount, judged.usage.inputTokens, judged.usage.costUsd, judged.usage.cached);
      if (judged.usage.cached) metrics.cacheHit("jev");
      metrics.accept("jev");
      const fit = judged.answers.fit?.choice;
      const fitCriteria = (questions.fit as { criteria?: Record<string, string> } | undefined)?.criteria;
      const unit = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
      const confident = (n: unknown) => unit(n) && n >= 0.6;
      const perspectiveProbs = judged.answers.perspective?.probabilities ?? {};
      const perspectives = Object.entries(perspectiveProbs)
        .filter(([, probability]) => unit(probability) && probability >= 0.15)
        .sort((a, b) => b[1] - a[1])
        .map(([name]) => name)
        .filter((name) => REVIEW_PERSPECTIVES.includes(name))
        .slice(0, 3);
      consume({
        preferred: typeof fit === "string" && fitCriteria && Object.hasOwn(fitCriteria, fit) && confident(judged.answers.fit?.probabilities?.[fit]) ? fitCriteria[fit] : undefined,
        noFit: confident(judged.answers.noFit?.noul),
        needsVerification: confident(judged.answers.needsVerification?.noul),
        reviewWorthy: confident(judged.answers.reviewWorthy?.noul),
        multiPerspective: confident(judged.answers.multiPerspective?.noul),
        perspectives,
        ok: true,
      });
    } catch {
      metrics.skip("jev", "unavailable");
      consume({ noFit: false, needsVerification: false, reviewWorthy: false, multiPerspective: false, perspectives: [], ok: false, skipped: "unavailable" });
    }
  })();
}
