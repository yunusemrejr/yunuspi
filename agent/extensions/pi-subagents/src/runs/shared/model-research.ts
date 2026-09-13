/** Bounded background research. Dispatch only reads the existing ranking cache.
 * Public model identifiers alone leave the machine; never task/project text.
 * A search hit is a lead, not a score or an instruction. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { getAgentDir } from "../../shared/utils.ts";
import type { ModelInfo } from "../../shared/model-info.ts";
import { modelIdentity, validBenchmark, type BenchmarkEvidence, type ModelDiscovery } from "./model-quality.ts";
import { readRankCache, refreshModelRankingCache } from "./model-selection.ts";
import { describeFreeRoutes } from "./free-route-evidence.ts";

export const AA_MODELS_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";
const REFRESH_MS = 6 * 60 * 60_000;
const MAX_RESEARCH_MODELS = 4;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
let pending: Promise<void> | undefined;

export async function boundedResearchJson(url: string, signal: AbortSignal, headers?: Record<string,string>): Promise<any> {
 const response = await fetch(url, { signal, headers, redirect: "error" });
 if (!response.ok) throw new Error(`Model evidence HTTP ${response.status}`);
 if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES) { await response.body?.cancel(); throw new Error("Model evidence too large"); }
 const reader = response.body?.getReader();
 if (!reader) throw new Error("Missing model evidence body");
 const chunks: Uint8Array[] = []; let size = 0;
 try {
  while (true) {
   const {value,done} = await reader.read(); if (done) break;
   size += value.byteLength; if (size > MAX_BODY_BYTES) throw new Error("Model evidence too large");
   chunks.push(value);
  }
 } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
 return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Exact creator/slug join only. Ambiguous identities and thinking variants
 * remain unknown; no fuzzy name matching across differently sized models. */
export function artificialAnalysisEvidence(body: any, models: ModelInfo[], at: number): BenchmarkEvidence[] {
 if (!Array.isArray(body?.data) || body.data.length > 10000) return [];
 const aliases = new Map<string,any[]>();
 for (const row of body.data) {
  if (typeof row?.slug !== "string" || typeof row.model_creator?.slug !== "string" || typeof row.id !== "string") continue;
  const key = modelIdentity(`${row.model_creator.slug}/${row.slug}`);
  aliases.set(key,[...(aliases.get(key) ?? []),row]);
 }
 const fields = [
  ["artificial_analysis_coding_index","coding",1], ["livecodebench","coding",100], ["scicode","coding",100],
  ["artificial_analysis_math_index","reasoning",1], ["gpqa","reasoning",100], ["math_500","reasoning",100],
  ["artificial_analysis_intelligence_index","general",1], ["mmlu_pro","general",100],
 ] as const;
 const evidence: BenchmarkEvidence[] = [];
 for (const id of new Set(models.map(m => modelIdentity(m.id)))) {
  const matches = aliases.get(id); if (matches?.length !== 1) continue;
  const row = matches[0];
  for (const [suite,domain,multiplier] of fields) {
   const value = row.evaluations?.[suite];
   if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value*multiplier > 100) continue;
   evidence.push({model:id,suite,protocol:`aa-api-v2:${at}`,domain,score:value*multiplier,source:AA_MODELS_URL,observedAt:at,authority:"independent"});
  }
 }
 return evidence;
}

/** Model-card metrics need explicit units. Never guess whether 0.8 is a
 * percentage, probability, loss, or an author-defined score. */
export function modelCardEvidence(body: any, id: string, at: number): BenchmarkEvidence[] {
 if (modelIdentity(body?.id ?? "") !== modelIdentity(id)) return [];
 const entries = body.cardData?.["model-index"];
 if (!Array.isArray(entries) || entries.length !== 1 || !Array.isArray(entries[0]?.results)) return [];
 const evidence: BenchmarkEvidence[] = [];
 for (const result of entries[0].results.slice(0,64)) {
  if (typeof result.dataset?.type !== "string" || typeof result.task?.type !== "string" || !Array.isArray(result.metrics)) continue;
  for (const metric of result.metrics.slice(0,16)) {
   const scale = metric?.unit === "percent" ? 1 : metric?.unit === "ratio" ? 100 : undefined;
   if (!scale || !["accuracy","exact_match","pass@1"].includes(metric.type) || typeof metric.value !== "number") continue;
   const domain = metric.type === "pass@1" ? "coding" : result.task.type === "question-answering" ? "reasoning" : "general";
   const b: BenchmarkEvidence = { model:modelIdentity(id),suite:`${result.dataset.type}:${metric.type}`,
    protocol:JSON.stringify([result.dataset.config ?? "",result.dataset.split ?? "",metric.args ?? {},metric.unit]),
    domain,score:metric.value*scale,source:`https://huggingface.co/${id}`,observedAt:at,authority:"publisher" };
   if (validBenchmark(b,at)) evidence.push(b);
  }
 }
 return evidence;
}

export interface ResearchDependencies {
 json?: typeof boundedResearchJson;
 search?: (query: string, signal: AbortSignal) => Promise<string[]>;
 now?: () => number;
 apiKey?: string;
}
async function searchSources(query: string, signal: AbortSignal): Promise<string[]> {
 const { searchWithDuckDuckGo } = await import("../../../../pi-web-access/duckduckgo.ts");
 const result = await searchWithDuckDuckGo(query,{signal,numResults:3});
 return result.results.map(r => r.url);
}

/** Single flight in process, exclusive short research lease across sessions.
 * Failed lookups are negatively cached; successful old evidence keeps its own
 * timestamp. Cancellation cannot publish fresh-looking partial results. */
export function refreshModelResearch(models: ModelInfo[], signal?: AbortSignal, deps: ResearchDependencies = {}): Promise<void> {
 if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_MODEL_RESEARCH === "off") return Promise.resolve();
 if (pending) return pending;
 pending = research(models,signal,deps).catch(() => {}).finally(() => {pending = undefined;});
 return pending;
}
async function research(models: ModelInfo[], signal: AbortSignal | undefined, deps: ResearchDependencies): Promise<void> {
 const now = deps.now ?? Date.now, at = now();
 const cache = readRankCache().cache;
 const publicModels = models.filter(m => ["openrouter","orcarouter"].includes(m.provider) && /^[\w.-]+\/[\w.:-]+$/.test(m.id));
 if (!publicModels.length) return;
 const catalogHash=createHash("sha256").update([...new Set(publicModels.map(m=>modelIdentity(m.id)))].sort().join("\n")).digest("hex");
 if (cache?.researchAt && at-cache.researchAt < REFRESH_MS && at >= cache.researchAt && cache.researchCatalog === catalogHash) return;
 // A crashed process can suppress only this time bucket, never all future
 // research. Persisted evidence still expires independently of this lease.
 const lock = path.join(getAgentDir(),"cache",`subagents-model-research.${Math.floor(at/REFRESH_MS)}.lock`);
 fs.mkdirSync(path.dirname(lock),{recursive:true});
 // Timestamped exclusive files are intentionally not stolen on a live task's
 // timeout; synchronous owner release below makes ordinary cancellation safe.
 try { fs.writeFileSync(lock,String(process.pid),{flag:"wx",mode:0o600}); } catch { return; }
 try {
  const control = new AbortController();
  const timeout = setTimeout(() => control.abort(),8000);
  const bounded = signal ? AbortSignal.any([signal,control.signal]) : control.signal;
  try {
   const json = deps.json ?? boundedResearchJson;
   const free = new Set(describeFreeRoutes(publicModels).candidates.filter(c=>c.eligible).map(c=>c.route));
   const checked = new Map(cache?.discoveries?.map(d=>[modelIdentity(d.model),d.checkedAt]));
   const shortlist = [...new Map(publicModels.slice().sort((a,b) => Number(free.has(b.fullId))-Number(free.has(a.fullId))
    || (checked.get(modelIdentity(a.id)) ?? 0)-(checked.get(modelIdentity(b.id)) ?? 0) || a.fullId.localeCompare(b.fullId)).map(m=>[modelIdentity(m.id),m])).values()].slice(0,MAX_RESEARCH_MODELS);
   const discoveries: ModelDiscovery[] = [];
   const fresh: BenchmarkEvidence[] = [];
   const apiKey = deps.apiKey ?? process.env.ARTIFICIAL_ANALYSIS_API_KEY;
   const jobs = Promise.allSettled([
    ...(apiKey ? [json(AA_MODELS_URL,AbortSignal.any([bounded,AbortSignal.timeout(6000)]),{"x-api-key":apiKey}).then(body => {fresh.push(...artificialAnalysisEvidence(body,publicModels,at));})] : []),
    ...shortlist.map(async model => {
     const id = modelIdentity(model.id);
     const sources: string[] = [];
     try {
      const body = await json(`https://huggingface.co/api/models/${id.split("/").map(encodeURIComponent).join("/")}`,AbortSignal.any([bounded,AbortSignal.timeout(3000)]));
      if (modelIdentity(body?.id ?? "") === id) { sources.push(`https://huggingface.co/${id}`); fresh.push(...modelCardEvidence(body,id,at)); }
     } catch { /* Missing card/units stays unknown. */ }
     // At most one search per cycle; links are for inspection, never admission.
     if (model === shortlist[0] && !fresh.some(b=>b.model===id) && !bounded.aborted) {
      try { sources.push(...await (deps.search ?? searchSources)(`"${id}" model benchmark evaluation official`,AbortSignal.any([bounded,AbortSignal.timeout(1500)]))); } catch { /* negative cache */ }
     }
     discoveries.push({model:id,checkedAt:at,sources:sources.filter(url=>{try{return new URL(url).protocol==="https:";}catch{return false;}}).slice(0,4)});
    }),
   ]);
   // Bound even an adapter that ignores AbortSignal. It cannot publish after
   // the race; the losing jobs may only mutate this discarded local snapshot.
   let abortListener: (()=>void) | undefined;
   await Promise.race([jobs,new Promise<void>(resolve=>{
    if(bounded.aborted) return resolve();
    abortListener=resolve; bounded.addEventListener("abort",resolve,{once:true});
   })]);
   if(abortListener) bounded.removeEventListener("abort",abortListener);
   if (bounded.aborted) return;
   const prior = readRankCache().cache;
   const merged = new Map((prior?.discoveries ?? []).map(d=>[d.model,d]));
   for (const d of discoveries) merged.set(d.model,d);
   const replaced = new Set(fresh.map(b=>`${b.model}\0${b.source}`));
   const observations = [...(prior?.observations ?? []).filter(b=>at-b.observedAt < 7*24*60*60_000 && !replaced.has(`${b.model}\0${b.source}`)),...fresh];
   await refreshModelRankingCache(async()=>({ok:true,body:{version:2,fetchedAt:new Date(at).toISOString(),asOf:new Date(at).toISOString(),researchAt:at,researchCatalog:catalogHash,
    observations:observations.slice(-10000),discoveries:[...merged.values()].sort((a,b)=>b.checkedAt-a.checkedAt).slice(0,1000)}}));
  } finally {clearTimeout(timeout);control.abort();}
 } finally {fs.rmSync(lock,{force:true});}
}
