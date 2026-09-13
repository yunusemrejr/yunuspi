/** Versioned snapshots of facts the catalog endpoints cannot express. These
 * retain the original evidence dates; expiry means unknown, never free. Wire
 * protocol adapters and explicit user configuration are separate authorities. */
export const MODEL_FACTS_VERSION = 1;
const deepseekFlash = {
  name: "DeepSeek V4.1 Flash", contextWindow: 1_000_000, maxTokens: 384_000,
  reasoning: true, input: ["text", "image"],
  thinkingLevelMap: {off:"none",minimal:"low",low:"low",medium:"high",high:"high",xhigh:"high",max:"max"},
  compat: {thinkingFormat:"deepseek",supportsReasoningEffort:true,requiresReasoningContentOnAssistantMessages:true,maxTokensField:"max_tokens"},
};
export const MODEL_FACTS = {
  cerebras: {
    verifiedAt:"2026-09-06", expiresAt:"2026-10-06T00:00:00Z", source:"existing harness output-limit probes",
    models:{"qwen-3.8-27b":{maxTokens:65_536},"qwen3-coder":{maxTokens:65_536},"gpt-oss-120b":{maxTokens:32_768}},
  },
  deepseek: {
    verifiedAt:"2026-09-10", expiresAt:"2026-10-10T00:00:00Z", source:"https://api-docs.deepseek.com/quick_start/pricing/",
    models:Object.fromEntries(["deepseek-flash","deepseek-v4-flash","deepseek-v4-flash-vision-exp"].map(id=>[id,deepseekFlash])),
  },
  runinfra: {
    verifiedAt:"2026-08-31", expiresAt:"2026-09-30T00:00:00Z", source:"existing harness wire probes and https://runinfra.ai/models",
    models:{}, imageIds:["glm-5-3-flash","qwen3-8-flash-next","ornith-1-5-35b","qwen3-8-27b"],
  },
};
export function currentModelFacts(provider: string, now = Date.now()): any {
  const entry = Object.hasOwn(MODEL_FACTS,provider) ? MODEL_FACTS[provider as keyof typeof MODEL_FACTS] : undefined;
  return entry && Number.isFinite(now) && now >= Date.parse(entry.verifiedAt) && now < Date.parse(entry.expiresAt) ? entry : undefined;
}
export function directDeepseekCost(id: string, now = Date.now()) {
  if (!currentModelFacts("deepseek",now)) return undefined;
  if (id === "deepseek-v4-pro") return now >= Date.parse("2026-09-14T04:00:00Z")
    ? {input:0.3,output:1.2,cacheRead:0.006,cacheWrite:0}
    : {input:1.32,output:3.96,cacheRead:0.044,cacheWrite:0};
  if (Object.hasOwn(MODEL_FACTS.deepseek.models,id)) return {input:0.3,output:1.2,cacheRead:0.006,cacheWrite:0};
}
