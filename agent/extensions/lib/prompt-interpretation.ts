/** Prompt-interpretation layer (deterministic first pass + sidecar contract).
 *
 * The main agent always reads the request first with full context; nothing
 * here delays or replaces that read. This module classifies follow-up shape
 * so the harness can offer ONE free tool-free second read on the narrow case
 * the main agent must otherwise read alone: an unclear follow-up ("handle
 * it", a bare "continue" after a pivot) with no explicit direction cues.
 * Initial prompts keep the existing auto-assist group; clear additive and
 * redirect follow-ups need no second opinion. Pure module: no I/O.
 */
import {
  isPromptPivot,
  isPromptRefusal,
  isReferentialFollowup,
} from "./intent-context.ts";

export type FollowupClass =
  | "initial"
  | "additive"
  | "redirect"
  | "unclear-followup";

/** Explicit course-change cues. Checked before additive cues: "also do X
 * instead" is a redirect, not an addition. */
const REDIRECT_CUES =
  /\b(?:instead|rather|scratch that|forget (?:it|that|this|about)|revert|undo|never mind|no[,.]?\s+(?:do|make|use|let|stop)|don'?t (?:do|bother|continue)|change (?:it|that|this) to|replace .* with)\b/i;

/** Explicit do-both cues. "too" only counts at the end ("fix this too") since
 * mid-sentence "too" usually grades ("too slow"). */
const ADDITIVE_CUES =
  /\b(?:also|additionally|plus|as well|another|and then|on top of that|while you(?:'re| are) at it|besides|in addition)\b|(?:\btoo\b[.!?]*\s*)$/i;

export function classifyFollowup(prompt: unknown): FollowupClass {
  if (typeof prompt !== "string" || !prompt.trim()) return "initial";
  const text = prompt.slice(0, 1024);
  if (isPromptPivot(text) || isPromptRefusal(text)) return "redirect";
  if (REDIRECT_CUES.test(text)) return "redirect";
  if (ADDITIVE_CUES.test(text)) return "additive";
  if (isReferentialFollowup(prompt)) return "unclear-followup";
  return "initial";
}

export type InterpRead = "additive" | "redirect" | "unclear";

/** Lenient parse of the sidecar's fixed-format reply. Undefined when the
 * model ignored the format, in which case the read stays silent. */
export function parseInterpRead(text: unknown): { read: InterpRead; why: string } | undefined {
  if (typeof text !== "string") return undefined;
  const head = text.slice(0, 2000);
  const read = /READ:\s*(additive|redirect|unclear)/i.exec(head)?.[1]?.toLowerCase();
  if (read !== "additive" && read !== "redirect" && read !== "unclear") return undefined;
  const why = (/WHY:\s*(.+)/i.exec(head)?.[1] ?? "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return { read, why };
}

/** Bounded sidecar brief: instruction + current prompt + prior user evidence.
 * The reader gets no tools and no session access; everything it may cite is
 * in this text (≤ ~4k chars). */
export function buildInterpBrief(prompt: string, priorEvidence: string): string {
  const current = prompt.trim().slice(0, 2000);
  const evidence = typeof priorEvidence === "string" ? priorEvidence.trim().slice(0, 1200) : "";
  return [
    "Second-read interpretation check. The main agent reads the request with full context; you only flag a likely misread.",
    "Classify the CURRENT request against the prior user evidence: additive (do both, keep prior scope) or redirect (replace/pivot prior scope). Reply unclear unless the evidence clearly supports one side.",
    "Return exactly two lines, no tools, no preamble:",
    "READ: additive|redirect|unclear",
    "WHY: ≤20 words, quoting at most 8 words from the request",
    "",
    `CURRENT: ${current || "(empty)"}`,
    evidence ? `PRIOR: ${evidence}` : "PRIOR: (none)",
  ].join("\n");
}
