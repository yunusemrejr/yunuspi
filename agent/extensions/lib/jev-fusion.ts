/**
 * Consensus-or-abstain fusion of two typed judge answers (Jev and Kev).
 *
 * Pure and I/O free. A single judge's `choice` answer is a full unit-sum
 * distribution over the candidates. When that answer is genuinely uncertain
 * (small margin AND no dominant option), a second judge from the other model
 * family is consulted and the two distributions are combined with a
 * geometric (logarithmic) opinion pool:
 *
 *     f_i  ∝  sqrt(p1_i · p2_i)
 *
 * Equal weights summing to one make the pool a consensus rule, not a
 * sharpener: agreement keeps the shared confidence, disagreement flattens the
 * distribution because an option only scores high when BOTH judges rate it
 * high. Downstream floors (top probability, margin) then reject a split
 * decision and consumers fall back to their local paths, instead of acting
 * on a coin flip. A small floor keeps either judge from vetoing an option
 * outright with a hard zero. Existence (`noul`) answers pool in logit space;
 * scores average. No weights are fitted: none of this is calibrated on
 * YunusPi tasks, so it never raises confidence above the more certain judge.
 */
import type { JevAnswer } from "./jev-client.ts";

/** A choice is uncertain only when it is both close and not dominated. */
export const SECOND_OPINION_MARGIN = 0.25;
export const SECOND_OPINION_TOP = 0.7;
/** Probability mass every option keeps before pooling (no absolute vetoes). */
const FLOOR = 0.02;
const LOGIT_CLAMP = 1e-4;

const unit = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** The validated distribution of a choice answer, or undefined when malformed. */
export function choiceDistribution(answer: Pick<JevAnswer, "type" | "probabilities"> | undefined): Record<string, number> | undefined {
  const probabilities = answer?.probabilities;
  if (answer?.type !== "choice" || !probabilities || typeof probabilities !== "object" || Array.isArray(probabilities)) return undefined;
  const entries = Object.entries(probabilities);
  if (entries.length < 2 || entries.some(([, value]) => !unit(value))) return undefined;
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  return Math.abs(total - 1) <= 1e-6 ? Object.fromEntries(entries) : undefined;
}

/** Margin between the two best options and the best probability. */
export function choiceSpread(distribution: Record<string, number>): { top: number; margin: number } {
  const sorted = Object.values(distribution).sort((a, b) => b - a);
  return { top: sorted[0] ?? 0, margin: (sorted[0] ?? 0) - (sorted[1] ?? 0) };
}

/** True when a valid choice answer is too close to act on from one judge. */
export function uncertainChoice(answer: Pick<JevAnswer, "type" | "probabilities"> | undefined): boolean {
  const distribution = choiceDistribution(answer);
  if (!distribution) return false;
  const { top, margin } = choiceSpread(distribution);
  return margin < SECOND_OPINION_MARGIN && top < SECOND_OPINION_TOP;
}

const smooth = (value: number, options: number): number => (1 - FLOOR) * value + FLOOR / options;

/** Geometric pool of two distributions over the same options; undefined when they differ. */
export function poolChoice(first: Record<string, number>, second: Record<string, number>): { probabilities: Record<string, number>; choice: string; agree: boolean } | undefined {
  const ids = Object.keys(first);
  if (ids.length < 2 || ids.length !== Object.keys(second).length || ids.some((id) => !Object.hasOwn(second, id))) return undefined;
  const raw = ids.map((id) => Math.sqrt(smooth(first[id], ids.length) * smooth(second[id], ids.length)));
  const total = raw.reduce((sum, value) => sum + value, 0);
  if (!(total > 0) || !Number.isFinite(total)) return undefined;
  const pooled = raw.map((value) => value / total);
  const top = (distribution: Record<string, number>) => ids.reduce((best, id) => (distribution[id] > distribution[best] ? id : best), ids[0]);
  const probabilities = Object.fromEntries(ids.map((id, index) => [id, pooled[index]]));
  // Ties go to the judge that answered first, then to candidate order.
  const best = Math.max(...pooled);
  const tied = ids.filter((id, index) => pooled[index] >= best - 1e-12);
  const choice = tied.includes(top(first)) ? top(first) : tied[0];
  return { probabilities, choice, agree: top(first) === top(second) };
}

/** Logit-space mean of two probabilities (existence judgments). */
export function poolUnit(first: number, second: number): number {
  const logit = (p: number) => { const c = Math.min(1 - LOGIT_CLAMP, Math.max(LOGIT_CLAMP, p)); return Math.log(c / (1 - c)); };
  const mean = (logit(first) + logit(second)) / 2;
  return 1 / (1 + Math.exp(-mean));
}

export type FusionSummary = { answers: Record<string, JevAnswer>; fused: number; agreed: number; split: number };

/**
 * Combine two answer sets question by question. Questions the second judge
 * answered incompatibly keep the first judge's answer unchanged.
 */
export function fuseAnswers(first: Record<string, JevAnswer>, second: Record<string, JevAnswer>, models: readonly [string, string]): FusionSummary {
  const answers: Record<string, JevAnswer> = {};
  let fused = 0, agreed = 0, split = 0;
  for (const [name, a] of Object.entries(first)) {
    const b = second[name];
    if (!b || b.type !== a.type) { answers[name] = a; continue; }
    if (a.type === "choice") {
      const left = choiceDistribution(a), right = choiceDistribution(b);
      const pooled = left && right ? poolChoice(left, right) : undefined;
      if (!pooled) { answers[name] = a; continue; }
      const confidences = [a.confidence, b.confidence].filter(unit);
      const pooledAnswer: JevAnswer = { ...a, choice: pooled.choice, probabilities: pooled.probabilities, fusion: { models: [models[0], models[1]], agree: pooled.agree } };
      if (confidences.length) pooledAnswer.confidence = confidences.reduce((sum, value) => sum + value, 0) / confidences.length;
      else delete pooledAnswer.confidence;
      answers[name] = pooledAnswer;
      fused++; if (pooled.agree) agreed++; else split++;
    } else if (a.type === "noul" && unit(a.noul) && unit(b.noul)) {
      answers[name] = { ...a, noul: poolUnit(a.noul, b.noul), fusion: { models: [models[0], models[1]], agree: (a.noul >= 0.5) === (b.noul >= 0.5) } };
      fused++;
    } else if (a.type === "score" && Number.isFinite(a.score) && Number.isFinite(b.score)) {
      answers[name] = { ...a, score: ((a.score as number) + (b.score as number)) / 2, fusion: { models: [models[0], models[1]], agree: true } };
      fused++;
    } else {
      answers[name] = a;
    }
  }
  return { answers, fused, agreed, split };
}
