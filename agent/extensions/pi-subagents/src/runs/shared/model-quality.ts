import type { ModelInfo } from "../../shared/model-info.ts";

/** Quality evidence describes a model, never the reputation of its serving API.
 * No model-name lists, price proxies, popularity scores or inferred releases. */
export type TaskDomain = "coding" | "reasoning" | "general";
export interface BenchmarkEvidence {
 model: string; // exact namespaced model id, including variant (apart from :free)
 suite: string;
 protocol: string; // source version / evaluation configuration; only like is compared
 domain: TaskDomain;
 score: number;
 source: string;
 observedAt: number;
 authority: "independent" | "publisher";
}
export interface ModelDiscovery {
 model: string;
 checkedAt: number;
 sources: string[]; // discovery only; snippets never become benchmark scores
}
export interface QualityTask {
 domain: TaskDomain;
 level: "advisory" | "standard" | "critical";
}
export const QUALITY_TTL_MS = 7 * 24 * 60 * 60_000;
export const modelIdentity = (id: string) => id.toLowerCase().replace(/:free$/, "");

export function taskQuality(task = ""): QualityTask {
 const text = task.slice(0, 32768).replace(/```[\s\S]*?```/g, " ").replace(/^\s*>.*$/gm, " ");
 const domain = /\b(code|coding|implement|refactor|debug|tests?|repository|function|typescript|python|api|harness)\b/i.test(text) ? "coding"
  : /\b(math|proof|reasoning|architecture|trade.?offs|analysis)\b/i.test(text) ? "reasoning" : "general";
 const advisory = /\b(read.only|advisory|brainstorm|propose|suggest|investigate|review|trace|summarize|extract|list)\b/i.test(text)
  && !/\b(implement|modify|write|edit|deploy|merge|approve|final verdict)\b/i.test(text.replace(/\b(?:do not|don't|never)\s+(?:modify|write|edit)\b/gi, ""));
 const critical = /\b(security|auth(?:entication|orization)?|cryptograph\w*|migration|payments?|billing|concurrency|production|critical|safety)\b/i.test(text);
 return { domain, level: advisory ? "advisory" : critical ? "critical" : "standard" };
}

export function validBenchmark(value: unknown, now = Date.now()): value is BenchmarkEvidence {
 const b = value as BenchmarkEvidence;
 if (!b || typeof b !== "object" || ![b.model,b.suite,b.protocol,b.source].every(v => typeof v === "string" && v.length > 0 && v.length <= 512 && !/[\x00-\x1f\x7f]/.test(v))) return false;
 if (!["coding","reasoning","general"].includes(b.domain) || !["independent","publisher"].includes(b.authority)) return false;
 if (!Number.isFinite(b.score) || b.score < 0 || b.score > 100 || !Number.isFinite(b.observedAt) || b.observedAt <= 0 || b.observedAt > now) return false;
 try {
  const url = new URL(b.source);
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  // Executable numeric evidence has two structured producers. Other web pages
  // remain references until a source adapter can establish units and identity.
  return b.authority === "independent" ? url.href === "https://artificialanalysis.ai/api/v2/data/llms/models"
   : url.hostname === "huggingface.co" && modelIdentity(decodeURIComponent(url.pathname.slice(1))) === modelIdentity(b.model);
 } catch { return false; }
}

/** Numeric version is only a tie-break after comparable performance evidence.
 * The rest of the namespaced identity must match: sizes and variants cannot
 * borrow a larger sibling's score. Dates/repository creation are not releases. */
export function compareModelVersions(a: string, b: string): number {
 const parse = (id: string) => {
  const match = /^(.*?)(\d+(?:\.\d+)+)([^\d]*)$/.exec(modelIdentity(id));
  return match ? { family: match[1] + "#" + match[3], parts: match[2].split(".").map(Number) } : undefined;
 };
 const x = parse(a), y = parse(b);
 if (!x || !y || x.family !== y.family) return 0;
 for (let i = 0; i < Math.max(x.parts.length,y.parts.length); i++) {
  const delta = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
  if (delta) return Math.sign(delta);
 }
 return 0;
}

export interface QualityVerdict {
 eligible: boolean;
 confidence: "measured" | "reference" | "unknown";
 relative?: number;
 suites: number;
 reason: string;
}

/** One cohort snapshot: each suite/protocol has its own denominator; scores
 * from different benchmarks are never averaged as if they shared a scale.
 * The weakest covered comparison is retained to expose regressions. */
export function assessModelQuality(models: ModelInfo[], observations: BenchmarkEvidence[], task: QualityTask, reference?: ModelInfo, now = Date.now()): Map<string, QualityVerdict> {
 const ids = new Set([...models, ...(reference ? [reference] : [])].map(m => modelIdentity(m.id)));
 const rows = observations.filter(b => validBenchmark(b, now) && now-b.observedAt < QUALITY_TTL_MS && ids.has(modelIdentity(b.model))
  && (b.domain === task.domain || task.domain === "general" && b.domain === "general"));
 const suiteKey = (b: BenchmarkEvidence) => JSON.stringify([b.suite,b.protocol,b.authority]);
 const best = new Map<string,number>();
 const coverage = new Map<string,number>();
 const byModel = new Map<string,Map<string,BenchmarkEvidence>>();
 const conflicts = new Map<string,number>();
 for (const b of rows) {
  const id = modelIdentity(b.model), key = suiteKey(b);
  const entries = byModel.get(id) ?? new Map();
  const old = entries.get(key);
  const conflictKey=JSON.stringify([id,key]);
  if (old && b.observedAt===old.observedAt && b.score!==old.score) {entries.delete(key);conflicts.set(conflictKey,b.observedAt);continue;}
  if ((conflicts.get(conflictKey)??0)>=b.observedAt) continue;
  if (!old || b.observedAt > old.observedAt) entries.set(key,b);
  byModel.set(id,entries);
 }
 for (const entries of byModel.values()) for (const [key,b] of entries) {best.set(key,Math.max(best.get(key) ?? 0,b.score));coverage.set(key,(coverage.get(key)??0)+1);}
 const referenceRows = reference ? byModel.get(modelIdentity(reference.id)) : undefined;
 return new Map(models.map(model => {
  const entries = byModel.get(modelIdentity(model.id));
  const comparable = [...(entries?.values() ?? [])].filter(b => (best.get(suiteKey(b)) ?? 0) > 0 && (coverage.get(suiteKey(b))??0)>=2);
  const relative = comparable.length ? Math.min(...comparable.map(b => {
   const referenceScore = referenceRows?.get(suiteKey(b))?.score;
   return b.score / (referenceScore && referenceScore > 0 ? referenceScore : best.get(suiteKey(b))!);
  })) : undefined;
  const same = !!reference && modelIdentity(reference.id) === modelIdentity(model.id);
  // A composite index and its components do not count as separate evidence.
  const independent = comparable.filter(b => b.authority === "independent" && !b.suite.endsWith("_index"));
  const coversReference = !referenceRows?.size || [...referenceRows.keys()].every(key => entries?.has(key));
  const enough = comparable.length > 0 && coversReference && (task.level !== "critical" || independent.length >= 2);
  const floor = task.level === "critical" ? .97 : task.level === "standard" ? .90 : .75;
  const measured = enough && relative !== undefined && relative >= floor;
  // Selected parent identity is an explicit baseline, not invented benchmark
  // evidence. Unknown peers are suitable only for independently checked advice.
  const eligible = measured || same || task.level === "advisory" && relative === undefined;
  return [model.fullId, {eligible, confidence: measured ? "measured" : same ? "reference" : "unknown", relative, suites: comparable.length,
   reason: measured ? `${comparable.length} comparable ${task.domain} benchmarks; worst relative score ${(relative!*100).toFixed(1)}%`
    : same ? "selected model identity retained; benchmark quality may be unknown"
    : relative === undefined ? "quality unknown; bounded advisory exploration only"
    : `quality gate: ${coversReference ? "insufficient evidence or performance" : "missing reference benchmark coverage"}; worst relative score ${(relative*100).toFixed(1)}%`} satisfies QualityVerdict];
 }));
}
