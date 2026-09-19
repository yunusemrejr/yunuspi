/** Review/council micro-intelligence primitives: perspective selection,
 * finding clustering and duplicate detection. The council/reviewer itself
 * stays full-LLM reasoning; these helpers only prepare, reduce and
 * structure evidence around it.
 *
 * All model dependencies are injected; nothing here launches subagents,
 * declares code correct, or establishes review completeness.
 */
import type { NeedleResult, NeedleRankResult } from "../needle-types.ts";
import { microMetrics } from "./metrics.ts";

export const COUNCIL_PERSPECTIVES = [
  { id: "architecture", text: "system structure, component boundaries, contracts, and design tradeoffs" },
  { id: "correctness", text: "logic errors, edge cases, behavioral regressions, and specification fit" },
  { id: "security", text: "authorization, injection, secrets handling, and trust boundaries" },
  { id: "performance", text: "latency, throughput, cost, complexity, and resource use" },
  { id: "maintainability", text: "clarity, coupling, technical debt, and future change cost" },
  { id: "product", text: "user value, requirements fit, scope, and experience quality" },
  { id: "testing", text: "verification evidence, coverage, and reproducibility" },
] as const;

export type RankFn = (
  query: string,
  candidates: Array<{ id: string; text: string }>,
  topK: number,
) => Promise<NeedleResult<NeedleRankResult>>;

export type JudgeFn = (
  site: string,
  state: unknown,
  questions: Record<string, unknown>,
) => Promise<
  | { ok: true; answers: Record<string, { choice?: string; noul?: number; probabilities?: Record<string, number> }>; usage: { inputTokens: number; cached: boolean; costUsd?: number } }
  | { ok: false; skipped: string }
>;

/** Rank council perspectives against the task. Returns ids, best first. */
export async function selectPerspectives(
  task: string,
  rank: RankFn | undefined,
  topK = 3,
): Promise<string[]> {
  const metrics = microMetrics();
  if (!rank || typeof task !== "string" || task.trim().length < 12) {
    metrics.skip("needle", "trivial");
    return [];
  }
  try {
    const result = await rank(task.slice(0, 1024), [...COUNCIL_PERSPECTIVES], topK);
    if (!result.ok) {
      metrics.skip("needle", result.reason);
      return [];
    }
    metrics.run("needle", result.ms);
    metrics.accept("needle");
    return result.value.ranked.map((entry) => entry.id);
  } catch {
    metrics.skip("needle", "unavailable");
    return [];
  }
}

export interface Finding {
  id: string;
  text: string;
}

/**
 * Cluster overlapping findings by meaning. Deterministic Jaccard
 * pre-filter first (cheap, exact-token); Needle confirms semantic
 * near-duplicates within candidate pairs. Returns groups of finding ids;
 * singletons are omitted. Order-stable and bounded.
 */
export async function clusterFindings(
  findings: Finding[],
  rank: RankFn | undefined,
  threshold = 0.9,
): Promise<string[][]> {
  const metrics = microMetrics();
  if (!Array.isArray(findings) || findings.length < 2 || findings.length > 64) return [];
  const termsOf = (text: string): Set<string> =>
    new Set(text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const termSets = findings.map((finding) => termsOf(finding.text));
  const jaccard = (a: Set<string>, b: Set<string>): number => {
    if (!a.size || !b.size) return 0;
    let common = 0;
    for (const term of a) if (b.has(term)) common++;
    return common / (a.size + b.size - common);
  };
  // Union-find over confirmed pairs.
  const parent = findings.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (a: number, b: number): void => {
    parent[find(a)] = find(b);
  };
  // Deterministic pass: high-overlap pairs merge without inference.
  for (let i = 0; i < findings.length; i++) {
    for (let j = i + 1; j < findings.length; j++) {
      if (jaccard(termSets[i], termSets[j]) >= 0.6) union(i, j);
    }
  }
  // Semantic pass: Needle ranks each finding against the others; mutual
  // top-1 pairs above threshold merge. Bounded to 8 rank calls.
  if (rank) {
    let calls = 0;
    for (let i = 0; i < findings.length && calls < 8; i++) {
      if (findings[i].text.length < 20) continue;
      const others = findings
        .map((finding, index) => ({ finding, index }))
        .filter(({ index }) => index !== i && find(index) !== find(i))
        .slice(0, 12);
      if (!others.length) continue;
      calls++;
      try {
        const result = await rank(
          findings[i].text.slice(0, 512),
          others.map(({ finding }) => ({ id: finding.id, text: finding.text.slice(0, 512) })),
          1,
        );
        if (result.ok && result.value.ranked.length) {
          const top = result.value.ranked[0];
          if (top.score >= threshold) {
            const partner = findings.findIndex((finding) => finding.id === top.id);
            if (partner >= 0) union(i, partner);
          }
          metrics.run("needle", result.ms);
        }
      } catch {
        break;
      }
    }
    if (calls) metrics.accept("needle");
  }
  const groups = new Map<number, string[]>();
  findings.forEach((finding, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(finding.id);
  });
  return [...groups.values()].filter((group) => group.length > 1);
}

/** Judge whether two findings are semantic duplicates (one batched call). */
export async function judgeDuplicatePair(
  a: Finding,
  b: Finding,
  ask: JudgeFn | undefined,
): Promise<{ duplicate: boolean; ok: boolean }> {
  const metrics = microMetrics();
  if (!ask || !a?.text || !b?.text) {
    metrics.skip("jev", "trivial");
    return { duplicate: false, ok: false };
  }
  try {
    const judged = await ask("finding-duplicate", { a: a.text.slice(0, 800), b: b.text.slice(0, 800) }, {
      duplicate: {
        type: "noul",
        instructions: "Do these two findings describe the same underlying issue (same cause, same location)?",
      },
    });
    if (!judged.ok) {
      metrics.skip("jev", judged.skipped);
      return { duplicate: false, ok: false };
    }
    metrics.run("jev");
    metrics.jevUsage("finding-duplicate", 1, judged.usage.inputTokens, judged.usage.costUsd ?? 0, judged.usage.cached);
    const score = judged.answers.duplicate?.noul ?? 0;
    if (score >= 0.75) {
      metrics.accept("jev");
      return { duplicate: true, ok: true };
    }
    if (score <= 0.25) {
      metrics.accept("jev");
      return { duplicate: false, ok: true };
    }
    metrics.skip("jev", "low-confidence");
    return { duplicate: false, ok: false };
  } catch {
    metrics.skip("jev", "unavailable");
    return { duplicate: false, ok: false };
  }
}
