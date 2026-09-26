/** Deterministic request cues and the advisory shape shared by consumers.
 * Semantic advice comes from the mandatory prompt-analysis owner; this module
 * performs no duplicate model request and grants no authority.
 */
import { taskTerms } from "../local-intelligence.mjs";
import { isPromptPivot, isPromptRefusal, isReferentialFollowup } from "../intent-context.ts";

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
