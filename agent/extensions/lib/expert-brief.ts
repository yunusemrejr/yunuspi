/**
 * Expert brief assembly — one owner for what the Director tells the agent.
 * Used identically by the prompt-time advisory path and the expert_director
 * tool so both agree on domains, doctrine, priors and exploration.
 * Taste recall is the only I/O, bounded to two small JSON reads.
 */
import { detectExpertDomains, detectTaskType, type ExpertDetectionInput, type ExpertDomainId } from "./expert-domains.ts";
import { EXPERT_DOMAIN_LABELS } from "./expert-domains.ts";
import { selectDoctrineBrief } from "./expert-doctrine.ts";
import { getDoctrinePack } from "./expert-doctrine.ts";
import { buildCriticPlan, criticPlanSummary } from "./expert-critics.ts";
import { readTasteStore, recallTaste, renderTasteContext, emptyTasteStore } from "./expert-taste.ts";
import { isTrivialChangeRequest } from "./review-coordinator.ts";

export function expertEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !["off", "0"].includes(env.PI_EXPERT ?? "on");
}

/** Children may read briefs, critics and verdicts but never write taste:
 * the taste store is harness state and D-008 keeps children read-only. */
export function expertTasteWritable(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_SUBAGENT_CHILD !== "1";
}

export interface ExpertBrief {
  qualified: boolean;
  domains: ExpertDomainId[];
  taskType: string;
  openEnded: boolean;
  /** Bounded advisory text for model context ("", when not qualified). */
  text: string;
  /** One TUI line describing what the brief told the agent. */
  summary: string;
  /** Machine-readable detail for the tool path and telemetry. */
  detail: {
    confidences: Record<string, number>;
    signals: Record<string, string[]>;
    packs: ExpertDomainId[];
    doctrineChars: number;
    doctrineTruncated: boolean;
    tasteApplied: number;
    lenses: string[];
    lensesDropped: string[];
    exploration: boolean;
  };
}

const BRIEF_BUDGET = 2000;

/** Prompt-time qualification: a domain must be detected with enough
 * confidence, trivial formatting/lint work never qualifies, and vague
 * one-liners without domain signal stay quiet. */
export function qualifiesForExpertBrief(
  detection: { domains: Array<{ domain: ExpertDomainId; confidence: number }>; taskType: string; openEnded: boolean },
  prompt: string,
  files: readonly string[] = [],
): boolean {
  if (!detection.domains.length) return false;
  if (isTrivialChangeRequest(prompt, files)) return false;
  if (detection.openEnded) return true;
  if (detection.taskType === "create" && detection.domains[0].confidence >= 0.4) return true;
  return detection.domains[0].confidence >= 0.6;
}

export function buildExpertBrief(input: ExpertDetectionInput & { projectId?: string; force?: boolean }): ExpertBrief {
  const empty: ExpertBrief = {
    qualified: false, domains: [], taskType: detectTaskType(input.prompt), openEnded: false, text: "", summary: "",
    detail: { confidences: {}, signals: {}, packs: [], doctrineChars: 0, doctrineTruncated: false, tasteApplied: 0, lenses: [], lensesDropped: [], exploration: false },
  };
  if (!expertEnabled()) return empty;
  const detection = detectExpertDomains(input);
  const files = (input.files ?? []).filter((f): f is string => typeof f === "string");
  const qualified = input.force === true
    ? detection.domains.length > 0
    : qualifiesForExpertBrief(detection, input.prompt, files);
  const domains = detection.domains.map((d) => d.domain);
  const confidences = Object.fromEntries(detection.domains.map((d) => [d.domain, d.confidence]));
  const signals = Object.fromEntries(detection.domains.map((d) => [d.domain, d.signals]));
  const doctrine = selectDoctrineBrief(detection.domains, { taskType: detection.taskType });
  const plan = buildCriticPlan(domains);
  let tastePrefs: ReturnType<typeof recallTaste> = [];
  try {
    const projectId = typeof input.projectId === "string" ? input.projectId : "";
    // Project priors need a resolved identity (the tool path supplies it);
    // the prompt-time path carries user priors only, never a shared file.
    const projectStore = projectId ? readTasteStore("project", projectId) : emptyTasteStore();
    tastePrefs = recallTaste(readTasteStore("user"), projectStore, projectId, domains);
  } catch { tastePrefs = []; }
  const detail: ExpertBrief["detail"] = {
    confidences, signals, packs: doctrine.packs, doctrineChars: doctrine.chars,
    doctrineTruncated: doctrine.truncated, tasteApplied: tastePrefs.length,
    lenses: plan.lenses.map((l) => l.lens.id), lensesDropped: plan.dropped,
    exploration: detection.openEnded && (detection.taskType === "create" || detection.taskType === "transform"),
  };
  if (!qualified) return { ...empty, domains, taskType: detection.taskType, openEnded: detection.openEnded, detail };
  const lines = [`Harness expert guidance (advisory; the user's words and project conventions win). Detected: ${domains.map((d) => EXPERT_DOMAIN_LABELS[d]).join(" + ")}; task: ${detection.taskType}.`];
  if (doctrine.text) lines.push(doctrine.text);
  const taste = renderTasteContext(tastePrefs);
  if (taste) lines.push(taste);
  if (detail.exploration) {
    const whens = doctrine.packs.map((p) => getDoctrinePack(p)?.exploreWhen).filter(Boolean).slice(0, 2);
    lines.push(`Explore before committing: sketch 2-3 materially different approaches (${whens.join(" ") || "compare on fit, quality and feasibility"}), choose with explicit criteria, record why in the plan, then execute through one clear owner.`);
  }
  if (detection.taskType === "transform") {
    lines.push("Preserve what must survive: before broad redesign/refactor work, name the behaviors, content and contracts that stay, and verify them afterward.");
  }
  lines.push(`Critics for this task: ${plan.lenses.map((l) => l.lens.role).join("; ") || "none"}. Run cheap deterministic checks first; judge the actual artifact (pixels, renders, test/failure evidence, final prose), not source intent.`);
  const text = lines.join("\n").slice(0, BRIEF_BUDGET);
  const summaryParts = [`${domains.map((d) => EXPERT_DOMAIN_LABELS[d]).join("+")} · ${detection.taskType}${detection.openEnded ? " · open" : ""}`];
  if (detail.exploration) summaryParts.push("explore alternatives before building");
  if (tastePrefs.length) summaryParts.push(`${tastePrefs.length} prior${tastePrefs.length === 1 ? "" : "s"}`);
  const planSummary = criticPlanSummary(plan);
  if (planSummary) summaryParts.push(planSummary.replace(/^Critics: /, "").replace(/\.$/, ""));
  return {
    qualified: true, domains, taskType: detection.taskType, openEnded: detection.openEnded,
    text, summary: `Expert brief: ${summaryParts.join(" · ")}.`,
    detail: { ...detail, doctrineChars: text.length },
  };
}
