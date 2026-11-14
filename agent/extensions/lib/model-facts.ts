/** Versioned snapshots of facts the catalog endpoints cannot express, with the
 * dates they were checked. Past its window a snapshot is stale, not gone: its
 * wire formats and limits stay the best evidence there is and keep applying
 * (knownModelFacts), while its prices stop being quoted (currentModelFacts),
 * so an old price is never shown as today's. The model directory supplies
 * fresher limits and prices when it has them. Explicit user configuration is a
 * separate authority and outranks both. */
export const MODEL_FACTS_VERSION: number = 1;
export interface ModelCostFacts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  knownFree?: true;
}
export interface ModelFactsEntry {
  verifiedAt: string;
  expiresAt: string;
  source: string;
  // Per-model fact bags intentionally stay open: each provider snapshot
  // carries only the fields its catalog cannot express.
  models: Record<string, any>;
  imageIds?: string[];
}
const deepseekFlash: Record<string, unknown> = {
  name: "DeepSeek V4.1 Flash", contextWindow: 1_000_000, maxTokens: 384_000,
  reasoning: true, input: ["text", "image"],
  thinkingLevelMap: {off:"none",minimal:"low",low:"low",medium:"high",high:"high",xhigh:"high",max:"max"},
  compat: {thinkingFormat:"deepseek",supportsReasoningEffort:true,requiresReasoningContentOnAssistantMessages:true,maxTokensField:"max_tokens"},
};
// Ant Ling's thinking switch is binary: the request field `thinking` takes enabled or
// disabled (the 3.x models think by default), so one level is offered, not effort tiers.
const antLingThinking: Record<string, unknown> = {
  reasoning: true,
  thinkingLevelMap: {off:"none",minimal:null,low:null,medium:"enabled",high:null,xhigh:null,max:null},
  compat: {thinkingFormat:"enabled",supportsReasoningEffort:false},
};
export const MODEL_FACTS: Record<string, ModelFactsEntry> = {
  "ant-ling": {
    verifiedAt:"2026-11-14", expiresAt:"2026-11-28T00:00:00Z", source:"https://developer.ant-ling.com/en/docs/models/ling/ and .../models/price/, with the live /models list and request probes of 2026-11-14; no output limit is published for any model; Ling-3.0-tiny's 131072 context is from its Hugging Face config",
    models:{
      "Ling-3.2-flash":{name:"Ling 3.2 Flash", contextWindow:1_000_000, input:["text","image"], ...antLingThinking},
      "Ling-3.1-flash":{name:"Ling 3.1 Flash", contextWindow:1_000_000, input:["text"], ...antLingThinking},
      "Ling-3.0-flash":{name:"Ling 3.0 Flash", contextWindow:262_144, input:["text"], ...antLingThinking},
      "Ling-3.0-flash-VL":{name:"Ling 3.0 Flash VL", contextWindow:262_144, input:["text","image"], ...antLingThinking},
      "Ling-3.0-tiny":{name:"Ling 3.0 Tiny", contextWindow:131_072, input:["text"], ...antLingThinking},
    },
  },
  cerebras: {
    verifiedAt:"2026-09-06", expiresAt:"2026-11-12T00:00:00Z", source:"re-verified 2026-10-13 against https://api.cerebras.ai/public/v1/models limits (live API is authoritative; these fill id-only fallback gaps)",
    models:{"qwen-3.8-27b":{maxTokens:32_768},"gpt-oss-120b":{maxTokens:40_960}},
  },
  deepseek: {
    verifiedAt:"2026-09-10", expiresAt:"2026-12-12T00:00:00Z", source:"https://api-docs.deepseek.com/quick_start/pricing/ (re-verified 2026-11-10; verifiedAt stays at first verification so historical price queries keep working)",
    models:Object.fromEntries(["deepseek-flash","deepseek-v4-flash","deepseek-v4-flash-vision-exp"].map(id=>[id,deepseekFlash])),
  },
  runinfra: {
    verifiedAt:"2026-08-31", expiresAt:"2026-11-12T00:00:00Z", source:"re-verified 2026-10-13 against existing harness wire probes and https://runinfra.ai/models",
    models:{}, imageIds:["glm-5-3-flash","qwen3-8-flash-next","ornith-1-5-35b","qwen3-8-27b"],
  },
};
export function currentModelFacts(provider: string, now = Date.now()): ModelFactsEntry | undefined {
  const entry = Object.hasOwn(MODEL_FACTS,provider) ? MODEL_FACTS[provider] : undefined;
  return entry && Number.isFinite(now) && now >= Date.parse(entry.verifiedAt) && now < Date.parse(entry.expiresAt) ? entry : undefined;
}
/** The snapshot once its evidence date has passed, stale or not. */
export function knownModelFacts(provider: string, now = Date.now()): ModelFactsEntry | undefined {
  const entry = Object.hasOwn(MODEL_FACTS,provider) ? MODEL_FACTS[provider] : undefined;
  return entry && Number.isFinite(now) && now >= Date.parse(entry.verifiedAt) ? entry : undefined;
}
/** The direct API's peak rates. Off-peak hours (all but 01:00–04:00 and
 * 06:00–10:00 UTC on weekdays) cost half; the core applies that per request. */
export function directDeepseekCost(id: string, now = Date.now()): ModelCostFacts | undefined {
  if (!currentModelFacts("deepseek",now)) return undefined;
  // The pro model was listed at the flash rate from 2026-09-14; the page read on
  // 2026-11-10 shows its earlier rate again. The day it changed back is not known.
  if (id === "deepseek-v4-pro") return now >= Date.parse("2026-09-14T04:00:00Z") && now < Date.parse("2026-11-10T00:00:00Z")
    ? {input:0.3,output:1.2,cacheRead:0.006,cacheWrite:0}
    : {input:1.32,output:3.96,cacheRead:0.044,cacheWrite:0};
  if (Object.hasOwn(MODEL_FACTS.deepseek.models,id)) return {input:0.3,output:1.2,cacheRead:0.006,cacheWrite:0};
}
/** Ant Ling prices are promotional yuan per million tokens and the end of the promotion
 * is not published, so each is quoted only until its review date. One yuan is 0.14988
 * US dollars: the ECB reference rate of 2026-11-13, from api.frankfurter.dev on 2026-11-14.
 * Cache writes carry no separate charge. */
const CNY_USD = 0.14988;
const usd = (yuan: number) => Math.round(yuan * CNY_USD * 1e6) / 1e6;
const antLingPrice = (input: number, output: number, cacheRead: number): ModelCostFacts =>
  ({input:usd(input), output:usd(output), cacheRead:usd(cacheRead), cacheWrite:0});
const antLingFlash30 = antLingPrice(0.14, 0.42, 0.028);
const ANT_LING_PRICES: Record<string, {reviewAt: string; cost: ModelCostFacts}> = {
  // Free for two weeks after the launch of about 4 November 2026; the price after that is not published.
  "Ling-3.2-flash": {reviewAt:"2026-11-18T00:00:00Z", cost:{input:0,output:0,cacheRead:0,cacheWrite:0,knownFree:true}},
  "Ling-3.1-flash": {reviewAt:"2026-11-28T00:00:00Z", cost:antLingPrice(0.5, 1.5, 0.1)},
  "Ling-3.0-flash": {reviewAt:"2026-11-28T00:00:00Z", cost:antLingFlash30},
  "Ling-3.0-flash-VL": {reviewAt:"2026-11-28T00:00:00Z", cost:antLingFlash30},
};
export function antLingCost(id: string, now = Date.now()): ModelCostFacts | undefined {
  const price = Object.hasOwn(ANT_LING_PRICES,id) ? ANT_LING_PRICES[id] : undefined;
  return price && currentModelFacts("ant-ling",now) && now < Date.parse(price.reviewAt) ? price.cost : undefined;
}
/** Models Ant Ling has withdrawn, with the moment it stopped serving them; its published
 * replacement for all three is Ling-3.1-flash (https://developer.ant-ling.com/en/docs/models/deprecation/).
 * The built-in catalog still lists them and /models may too. */
const ANT_LING_RETIRED: Record<string, string> = {
  "Ling-2.6-1T":"2026-11-14T16:00:00Z", "Ling-2.6-flash":"2026-11-14T16:00:00Z", "Ring-2.6-1T":"2026-11-14T16:00:00Z",
};
export function antLingRetired(id: string, now = Date.now()): boolean {
  return Object.hasOwn(ANT_LING_RETIRED,id) && now >= Date.parse(ANT_LING_RETIRED[id]);
}
