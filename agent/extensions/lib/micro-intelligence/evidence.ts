/** Evidence pipeline router. For each substantial tool result, decide which
 * ML stages deserve an opportunity — deterministically, by content shape:
 *
 *   RAW TOOL RESULT -> deterministic classification (here)
 *     -> deterministic distiller (owner runs it first; its win ends routing)
 *     -> Smol for line/structured/noisy shapes
 *     -> Kompress for prose/block shapes
 *     -> Needle semantic relevance when meaning matters
 *     -> Jev validation when ambiguity matters
 *
 * This module only routes; subsystem owners keep execution, sealing and
 * fallback behavior. Routing never runs all four helpers on every result.
 */
import { miniSource } from "../mini-preprocessor.ts";
import { safeSmolOutput } from "../smol-preprocessor.ts";
import { evidenceBlocks } from "../local-intelligence.mjs";

export type ContentShape =
  | "trivial" | "unsupported" | "structured" | "prose" | "mixed";

export interface EvidenceRoute {
  shape: ContentShape;
  /** Deterministic distiller should run first (owner decides the win). */
  deterministicFirst: boolean;
  smol: boolean;
  kompress: boolean;
  needle: boolean;
  jev: boolean;
  reasons: string[];
}

const STRUCTURED_MARKERS = [
  /^diff --git /m,
  /^@@ /m,
  /^(?:TAP version \d|# (?:tests|pass|fail) \d|Test Suites:|Tests:)/m,
  /\berror TS\d{3,5}\b|\berror\[E\d{3,5}\]/,
  /^.+:\d+:\d+: (?:fatal )?(?:error|warning):/m,
  /Traceback \(most recent call last\)/,
  /^\s*at \S+ \(.+:\d+:\d+\)/m,
  /^\[?\d{4}-\d\d-\d\d[T ]\d\d:\d\d/m,
  /^\[(?:INFO|DEBUG|WARN|ERROR)\]/m,
];

const NOISE_RATIO = 0.6;

function structuredScore(text: string): number {
  let score = 0;
  for (const marker of STRUCTURED_MARKERS) if (marker.test(text)) score += 2;
  const lines = text.split("\n");
  if (lines.length > 12) score += 1;
  // Short line-oriented output with symbols/paths/numbers reads structured.
  let short = 0;
  for (const line of lines.slice(0, 60)) {
    if (line.length > 0 && line.length < 160 && /[:/\\#$\d]/.test(line)) short++;
  }
  if (lines.length >= 8 && short / Math.max(1, Math.min(lines.length, 60)) > NOISE_RATIO) score += 1;
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.length >= 4) score += 2;
  } catch { /* Not JSON: no signal either way. */ }
  return score;
}

function proseScore(text: string): number {
  let score = 0;
  if (miniSource(text)) score += 3;
  else if (evidenceBlocks(text)) score += 2;
  const paragraphs = text.split(/\n[ \t]*\n+/).filter((part) => part.trim().length > 40);
  if (paragraphs.length >= 3) score += 1;
  // Sentence-terminated lines are prose-like; code/symbols are not.
  const lines = text.split("\n").filter((line) => line.trim().length > 20);
  if (lines.length >= 4) {
    const terminated = lines.filter((line) => /[.!?]["')]?\s*$/.test(line)).length;
    if (terminated / lines.length > 0.6) score += 1;
  }
  return score;
}

/** Deterministic content-shape classification. Pure and total. */
export function contentShape(text: unknown): ContentShape {
  if (typeof text !== "string" || text.length < 400 || text.includes("\0")) return "trivial";
  if (text.length > 262144) return "unsupported";
  // Binary/control-heavy output is not ML evidence.
  const sample = text.slice(0, 8192);
  const odd = (sample.match(/[^\x09\x0a\x0d\x20-\x7e]/g) ?? []).length;
  if (odd / Math.max(1, sample.length) > 0.3) return "unsupported";
  const structured = structuredScore(text);
  const prose = proseScore(text);
  if (structured >= 2 && prose >= 2) return "mixed";
  if (structured >= 2) return "structured";
  if (prose >= 2) return "prose";
  // Long line-oriented output defaults to structured handling; long
  // paragraph output defaults to prose handling.
  if (text.length >= 3000 && text.split("\n").length >= 10) return "structured";
  if (text.length >= 3000) return "prose";
  return "trivial";
}

export interface RouteInput {
  tool: string;
  text: string;
  isError: boolean;
  details?: unknown;
  /** True when the deterministic distiller already produced a projection. */
  distilled?: boolean;
  /** Observation signature for processed-tracking (optional). */
  evidenceId?: string;
  alreadyProcessedBy?: string[];
}

/**
 * Route one tool result to ML stages. The deterministic distiller always
 * runs first at the owner; when it wins, no ML stage is offered.
 */
export function routeEvidence(input: RouteInput): EvidenceRoute {
  const { tool, text, isError } = input;
  const shape = contentShape(text);
  const reasons: string[] = [`shape=${shape}`];
  const route: EvidenceRoute = {
    shape, deterministicFirst: true,
    smol: false, kompress: false, needle: false, jev: false, reasons,
  };
  if (shape === "trivial" || shape === "unsupported") {
    // Small failures are still worth a semantic triage cue when they carry
    // enough text to classify; only their selection stages stay off.
    if (!(input.isError && text.length >= 800 && shape === "trivial")) {
      reasons.push(shape === "trivial" ? "too-small" : "unsupported-shape");
      return route;
    }
    reasons.push("trivial-error-triage");
  }
  if (input.distilled === true) {
    reasons.push("deterministic-won");
    return route;
  }
  const processed = new Set(input.alreadyProcessedBy ?? []);

  // Smol: line/structured/noisy shapes. Error output is eligible for
  // candidate-error-region selection only through the async offer path;
  // safeSmolOutput keeps its conservative sync contract.
  if ((shape === "structured" || shape === "mixed") && !processed.has("smol")) {
    if (safeSmolOutput(tool, text, false, input.details)) {
      route.smol = true;
      reasons.push("smol:line-shaped");
    } else if (["bash", "read", "grep", "find", "ls"].includes(tool) && text.length <= 32768 && text.split("\n").length >= 8) {
      // Chunked async opportunity (see smol-preprocessor chunk offers):
      // large line output the sync gate rejects can still warm selections.
      route.smol = true;
      reasons.push("smol:chunked-opportunity");
    } else {
      reasons.push("smol:ineligible-shape");
    }
  }

  // Kompress: prose/block shapes.
  if ((shape === "prose" || shape === "mixed") && !processed.has("kompress")) {
    if (miniSource(text)) {
      route.kompress = true;
      reasons.push("kompress:prose-shaped");
    } else if (evidenceBlocks(text) && text.length >= 1500) {
      route.kompress = true;
      reasons.push("kompress:block-shaped");
    } else {
      reasons.push("kompress:ineligible-shape");
    }
  }

  // Needle: semantic relevance / error-family cues when meaning matters.
  // Failures, prose evidence and mixed results benefit; tiny structured
  // dumps do not pay for an embedding round-trip.
  if (!processed.has("needle")) {
    if (isError && text.length >= 800) {
      route.needle = true;
      reasons.push("needle:error-family");
    } else if ((shape === "prose" || shape === "mixed") && text.length >= 1500) {
      route.needle = true;
      reasons.push("needle:prose-relevance");
    } else if (shape === "structured" && text.length >= 6000) {
      route.needle = true;
      reasons.push("needle:large-structured");
    } else {
      reasons.push("needle:not-worth-cost");
    }
  }

  // Jev: ambiguity that matters. Large prose without local coverage (the
  // existing distill rule), or error output whose family is uncertain.
  if (!processed.has("jev")) {
    if (!route.smol && !route.kompress && text.length >= 6000 && !isError) {
      route.jev = true;
      reasons.push("jev:uncovered-prose");
    } else if (isError && route.needle && text.length >= 3000) {
      route.jev = true;
      reasons.push("jev:error-triage");
    } else {
      reasons.push("jev:not-worth-cost");
    }
  }
  return route;
}
