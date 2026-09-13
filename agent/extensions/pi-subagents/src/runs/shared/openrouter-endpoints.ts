// Shared endpoint discovery for /provider and bounded session recovery.
// Only catalog metadata is requested; no prompts or inference probes are sent.
export interface Endpoint {
	tag: string;
	provider_name?: string;
	quantization?: string;
	context_length?: number;
	max_completion_tokens?: number;
	pricing?: Record<string, string>;
	status?: number;
	uptime_last_30m?: number;
	uptime_month?: number;
	latency_last_30m?: number | { p50?: number; p90?: number };
	throughput_last_30m?: number | { p50?: number; p90?: number };
	supports_tool_choice?: boolean;
	supported_parameters?: string[];
	max_prompt_tokens?: number;
}

export function endpointMetric(value: number | {p50?:number; p90?:number} | undefined): number | undefined {
 const n = typeof value === "object" && value ? value.p50 : value;
 return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}
export async function fetchEndpoints(modelId: string, signal?: AbortSignal): Promise<Endpoint[]> {
 if (!modelId || modelId.length > 512 || modelId.split("/").some(part => !part || part === "." || part === "..")) return [];
 const response = await fetch(`https://openrouter.ai/api/v1/models/${modelId.split("/").map(encodeURIComponent).join("/")}/endpoints`, {
  signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
  redirect: "error",
 });
 if (!response.ok) throw new Error(`endpoints fetch failed (HTTP ${response.status})`);
 const body = await response.json() as {data?:{id?:string;endpoints?:Endpoint[]}};
 if (body.data?.id && body.data.id !== modelId || !Array.isArray(body.data?.endpoints)) return [];
 return body.data.endpoints.slice(0,256).filter(e => e && typeof e.tag === "string" && e.tag.trim().length > 0 && e.tag.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(e.tag) && (e.status ?? 0) === 0);
}

import { endpointHealthKey, evaluateRoute, readHealth, recoveryPerformance } from "./provider-health.ts";

export function endpointMatches(tag: string, slug: string): boolean {
 return tag.toLowerCase()===slug.toLowerCase() || tag.toLowerCase().startsWith(slug.toLowerCase()+"/");
}
export function endpointRecoveryRouting(endpoint: Endpoint, original: Record<string, any>, caps: {prompt:number;completion:number}): Record<string,any> {
 return {...original,only:[endpoint.tag],order:[endpoint.tag],allow_fallbacks:false,require_parameters:true,
  max_price:{...original.max_price,prompt:caps.prompt,completion:caps.completion}};
}
/** Preserve hard allowlists, ignores, privacy and price controls. Live parameter
 * support and capacity are mandatory. Unknown price is never a cheap endpoint. */
export function rankRecoveryEndpoints(endpoints: Endpoint[], input: {
 model: {provider:string;id:string;cost:any;baseUrl?:string;api?:string};
 routing: Record<string,any>; visited: Set<string>; failedProvider?:string;
 contextTokens:number; outputTokens:number; tools:boolean; reasoning:boolean;
 caps:{prompt:number;completion:number}; now?:number;
}): Endpoint[] {
 const {model,routing,caps}=input, now=input.now??Date.now(), state=readHealth();
 const slugs=(key:string)=>Array.isArray(routing[key])?routing[key].filter((s:unknown)=>typeof s==="string"):[];
 const only=slugs("only"), ignore=slugs("ignore"), order=slugs("order");
 const price=(value:unknown)=>(typeof value==="string" && value.trim() || typeof value==="number") ? Number(value)*1e6 : NaN;
 const rows=endpoints.filter(endpoint=>{
  if (!endpoint || typeof endpoint.tag !== "string" || !endpoint.tag.trim() || endpoint.tag.length>128 || /[\x00-\x1f\x7f]/.test(endpoint.tag) || (endpoint.status??0)!==0) return false;
  if (input.visited.has(endpoint.tag) || endpoint.provider_name && endpoint.provider_name.toLowerCase()===input.failedProvider?.toLowerCase()) return false;
  if (only.length && !only.some((slug:string)=>endpointMatches(endpoint.tag,slug)) || ignore.some((slug:string)=>endpointMatches(endpoint.tag,slug))) return false;
  if (routing.allow_fallbacks===false && (!order.length || !order.some((slug:string)=>endpointMatches(endpoint.tag,slug)))) return false;
  if (!(Number.isSafeInteger(endpoint.context_length) && endpoint.context_length!>=input.contextTokens+input.outputTokens)) return false;
  if (!(Number.isSafeInteger(endpoint.max_completion_tokens) && endpoint.max_completion_tokens!>=input.outputTokens)) return false;
  if (endpoint.max_prompt_tokens!==undefined && !(endpoint.max_prompt_tokens>=input.contextTokens)) return false;
  const parameters=endpoint.supported_parameters??[];
  if(input.tools && !parameters.includes("tools") || input.reasoning && !parameters.includes("reasoning")) return false;
  if(Array.isArray(routing.quantizations) && !routing.quantizations.includes(endpoint.quantization))return false;
  const prompt=price(endpoint.pricing?.prompt),completion=price(endpoint.pricing?.completion);
  if(!Number.isFinite(prompt)||prompt<0||prompt>caps.prompt||!Number.isFinite(completion)||completion<0||completion>caps.completion)return false;
  // Fixed per-request/image charges would defeat a token-only comparison.
  for(const key of ["request","image"])if(endpoint.pricing?.[key]!==undefined && price(endpoint.pricing[key])!==0)return false;
  return evaluateRoute({provider:model.provider,model:model.id,endpoints:[endpoint.tag,...(endpoint.provider_name?[endpoint.provider_name]:[])],now},state).allowed;
 }).map(endpoint=>{
  const key=endpointHealthKey(model.id,endpoint.provider_name??endpoint.tag);
  const history=recoveryPerformance(state.providers[model.provider]?.models[key],model,now);
  const latency=endpointMetric(endpoint.latency_last_30m),speed=endpointMetric(endpoint.throughput_last_30m);
  const uptime=typeof endpoint.uptime_last_30m==="number"&&Number.isFinite(endpoint.uptime_last_30m)?Math.max(0,Math.min(100,endpoint.uptime_last_30m)):undefined;
  const priceRatio=(price(endpoint.pricing?.prompt)+price(endpoint.pricing?.completion))/Math.max(.001,caps.prompt+caps.completion);
  return {endpoint,score:history.failureRate*4+(uptime===undefined?.5:(100-uptime)/25)+priceRatio*.5+(latency===undefined?.5:Math.min(2,latency/5))+(speed===undefined?.5:1/(1+speed/20))};
 });
 return rows.sort((a,b)=>a.score-b.score||a.endpoint.tag.localeCompare(b.endpoint.tag)).map(row=>row.endpoint);
}
