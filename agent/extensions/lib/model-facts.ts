/** Versioned snapshots of facts the catalog endpoints cannot express. These
 * retain the original evidence dates; expiry means unknown, never free. Wire
 * protocol adapters and explicit user configuration are separate authorities. */
export const MODEL_FACTS_VERSION: number = 1;
export interface ModelCostFacts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
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
export const MODEL_FACTS: Record<string, ModelFactsEntry> = {
  cerebras: {
    verifiedAt:"2026-09-06", expiresAt:"2026-11-12T00:00:00Z", source:"re-verified 2026-10-13 against https://api.cerebras.ai/public/v1/models limits (live API is authoritative; these fill id-only fallback gaps)",
    models:{"qwen-3.8-27b":{maxTokens:32_768},"gpt-oss-120b":{maxTokens:40_960}},
  },
  deepseek: {
    verifiedAt:"2026-09-10", expiresAt:"2026-11-12T00:00:00Z", source:"https://api-docs.deepseek.com/quick_start/pricing/ (re-verified 2026-10-13; verifiedAt stays at first verification so historical price queries keep working)",
    models:Object.fromEntries(["deepseek-flash","deepseek-v4-flash","deepseek-v4-flash-vision-exp"].map(id=>[id,deepseekFlash])),
  },
  runinfra: {
    verifiedAt:"2026-08-31", expiresAt:"2026-09-30T00:00:00Z", source:"existing harness wire probes and https://runinfra.ai/models",
    models:{}, imageIds:["glm-5-3-flash","qwen3-8-flash-next","ornith-1-5-35b","qwen3-8-27b"],
  },
};
export function currentModelFacts(provider: string, now = Date.now()): ModelFactsEntry | undefined {
  const entry = Object.hasOwn(MODEL_FACTS,provider) ? MODEL_FACTS[provider] : undefined;
  return entry && Number.isFinite(now) && now >= Date.parse(entry.verifiedAt) && now < Date.parse(entry.expiresAt) ? entry : undefined;
}
export function directDeepseekCost(id: string, now = Date.now()): ModelCostFacts | undefined {
  if (!currentModelFacts("deepseek",now)) return undefined;
  if (id === "deepseek-v4-pro") return now >= Date.parse("2026-09-14T04:00:00Z")
    ? {input:0.3,output:1.2,cacheRead:0.006,cacheWrite:0}
    : {input:1.32,output:3.96,cacheRead:0.044,cacheWrite:0};
  if (Object.hasOwn(MODEL_FACTS.deepseek.models,id)) return {input:0.3,output:1.2,cacheRead:0.006,cacheWrite:0};
}
