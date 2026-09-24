/** Cheap task-mutation pre-screen: Needle semantic classification, then one
 * Jev judgment, before any full-LLM intent arbitration. Asymmetric by
 * design (false rescue is dangerous); see PRESCREEN_BARS. Anything
 * uncertain defers to the full arbiter. Never throws.
 */
import { needleClassify } from "../needle-runtime.ts";
import { askJev } from "../jev-client.ts";
import { localLm } from "../local-lm.ts";
import { microMetrics } from "./metrics.ts";

export type MutationScreenVerdict = "read-only" | "implementation" | "unavailable" | "defer";

export const PRESCREEN_LABELS = [
  { id: "read-only", text: "The task only reads, reviews, inspects, searches, explains or summarizes existing code and files. It produces understanding, reports or answers and never modifies anything." },
  { id: "implementation", text: "The task creates, edits, writes, modifies, deletes, implements, fixes or refactors files, code, tests or configuration on disk." },
];

/**
 * Asymmetric pre-screen bars (calibrated 2026-09-19 on 8 fixtures):
 * - implementation keeps the guard (fail-safe): score >= 0.90, margin >= 0.005.
 * - read-only rescues the run (dangerous): score >= 0.94, margin >= 0.01.
 * Everything else defers to Jev, then to the full arbiter. Shadow mode and
 * the metrics ledger keep these bars honest in production.
 */
export const PRESCREEN_BARS = {
  implementation: { score: 0.9, margin: 0.005 },
  readOnly: { score: 0.94, margin: 0.01 },
} as const;

/**
 * Screen-then-fallback orchestration shared by cheap pre-screens: the
 * screen runs first and its verdict stands unless it defers or throws,
 * in which case the (expensive) fallback decides.
 */
export async function resolveWithScreen<T>(
  screen: () => Promise<T | "defer">,
  fallback: () => Promise<T>,
): Promise<{ verdict: T; screened: boolean }> {
  try {
    const verdict = await screen();
    if (verdict !== "defer") return { verdict, screened: true };
  } catch {
    /* A pre-screen failure must not change the guarded outcome. */
  }
  return { verdict: await fallback(), screened: false };
}

/** Local-model stage (Qwen3.5-0.8B, free): measured on 12 real prompts, every
 * file-changing task scored P>=0.51 but one (0.38) and every read-only task
 * P<=0.42. It may only decide the fail-safe "implementation" direction; the
 * dangerous read-only rescue stays with Needle's strict bar, Jev and the arbiter. */
export const LOCAL_IMPLEMENTATION_AT = 0.5;
const MUTATION_EXAMPLES = `Decide if a task instructs an AI agent to create, edit or delete files, code or configuration.
Task: Explain how the caching layer works.
Changes files: no
Task: Add input validation to the signup form.
Changes files: yes
Task: Review the auth module and list any bugs you find.
Changes files: no
Task: Rename the config key and update all callers.
Changes files: yes
`;
export async function cheapMutationScreen(task: string, deps: { classify?: typeof needleClassify; ask?: typeof askJev; judge?: (prompt: string) => Promise<{ ok: boolean; p?: number }> } = {}): Promise<MutationScreenVerdict> {
  if (process.env.PI_INTENT_PRESCREEN === "off") return "defer";
  if (typeof task !== "string" || task.length < 12 || task.length > 8000) return "defer";
  const metrics = microMetrics();
  try {
    const ranked = await (deps.classify ?? needleClassify)({ text: task.slice(0, 512), labels: PRESCREEN_LABELS, acceptAt:PRESCREEN_BARS.implementation.score, marginAt:PRESCREEN_BARS.implementation.margin });
    if (ranked.ok && !ranked.shadow && ranked.value.accepted) {
      const { label, score, margin } = ranked.value;
      const bars = PRESCREEN_BARS;
      if (label === "implementation" && score >= bars.implementation.score && margin >= bars.implementation.margin) {
        metrics.llmAvoided(800);
        return "implementation";
      }
      // A clipped prefix cannot establish the absence of a later mutation.
      if (task.length <= 512 && label === "read-only" && score >= bars.readOnly.score && margin >= bars.readOnly.margin) {
        metrics.llmAvoided(800);
        return "read-only";
      }
    }
  } catch {
    /* Fall through to the local model, Jev, then the full arbiter. */
  }
  try {
    const judge = deps.judge ?? ((prompt: string) => localLm().judge(prompt, "mutation-intent"));
    const local = await judge(`${MUTATION_EXAMPLES}Task: ${task.replace(/\s+/g, " ").slice(0, 600)}\nChanges files:`);
    if (local.ok && typeof local.p === "number" && local.p >= LOCAL_IMPLEMENTATION_AT) {
      metrics.llmAvoided(800);
      return "implementation";
    }
  } catch {
    /* The local stage only ever shortcuts the fail-safe direction. */
  }
  try {
    const judged = await (deps.ask ?? askJev)("intent", { task }, {
      instructsChanges: {
        type: "noul",
        instructions: "Does this task instruct the agent to create, edit, or delete files or code?",
      },
    });
    if (judged.ok) {
      const answer = judged.answers.instructsChanges;
      const score = answer?.noul;
      if (answer?.type !== 'noul' || typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) return 'defer';
      metrics.run("jev");
      metrics.jevUsage("intent", 1, judged.usage.inputTokens, judged.usage.costUsd, judged.usage.cached);
      if (score <= 0.15) {
        metrics.accept("jev");
        metrics.llmAvoided(800);
        return "read-only";
      }
      if (score >= 0.85) {
        metrics.accept("jev");
        metrics.llmAvoided(800);
        return "implementation";
      }
      metrics.skip("jev", "low-confidence");
    }
  } catch {
    /* Fall through to the full arbiter. */
  }
  return "defer";
}
