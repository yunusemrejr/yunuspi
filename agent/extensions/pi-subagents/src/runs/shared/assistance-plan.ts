import type { ModelInfo } from "../../shared/model-info.ts";
import { catalogRouteCapabilities, isProvenFreeRoute } from "./free-route-evidence.ts";
import { modelIdentity, taskQuality } from "./model-quality.ts";
import { selectAffordableModel } from "./model-selection.ts";
import { distributeLlmPreferredModels, withLlmThinkingSuffix } from "./model-fallback.ts";
import type { ModelEconomyConfig } from "./model-economy.ts";

export interface AssistancePlan {
 mode: "none" | "subagent" | "swarm" | "fusion";
 roles: string[];
 reason: string;
 deadlineMs: number;
 maxCostUsd: number;
}
/** Local task-shape signals, not claims of semantic certainty. Automatic work
 * is bounded and read-only; the parent owns project changes and final checks. */
export function planAssistance(prompt: string, project = false): AssistancePlan {
 const text = prompt.slice(0,32768).replace(/```[\s\S]*?```/g," ").replace(/^\s*>.*$/gm," ");
 const none = (reason:string): AssistancePlan => ({mode:"none",roles:[],reason,deadlineMs:0,maxCostUsd:0});
 if (/\b(?:do not|don't|never)\s+(?:delegate|use\s+(?:subagents?|swarms?|fusion))\b|\bno\s+(?:subagents?|delegation|swarms?|fusion|tools)\b|\bwithout tools\b/i.test(text)) return none("explicit delegation constraint");
 if (/\b(?:only use|use only|stick to|stay on)\b(?!\s+(?:the\s+)?free\b)/i.test(text)) return none("explicit route/tool restriction");
 if (text.length < 35 || /\b(?:typo|spelling|rename|one.line)\b/i.test(text) && !/\b(?:debug|investigate|audit)\b/i.test(text)) return none("coordination exceeds useful work");
 if (!/\b(?:review|debug|research|compare|implement|investigate|audit|refactor|refine|optimize|design|build|fix|analy[sz]e|improve|verify|test|deploy|release|publish|migrat(?:e|ion))\b/i.test(text)) return none("no independent work identified");
 const alternatives = /\b(?:compare|alternatives|trade.?offs|competing|choose between|architecture|design decision)\b/i.test(text);
 const broad = /\b(?:multiple|cross.service|cross.file|end.to.end|migration|subsystems|frontend and backend|independent review)\b/i.test(text)
  || /\bcorrectness\b/i.test(text) && /\bconcurrency\b/i.test(text)
  || (text.match(/\b[\w/-]+\.(?:ts|js|py|go|rs|tsx|java)\b/g)?.length ?? 0) >= 2;
 const critical = taskQuality(text).level === "critical";
 if (alternatives) return {mode:"fusion",roles:["Independently propose the best approach with source evidence, tradeoffs and falsifiable checks","Independently challenge the proposed direction: find alternatives, counterexamples and decisive checks"],reason:"competing approaches benefit from independent answers and synthesis",deadlineMs:30000,maxCostUsd:.02};
 if (broad) return {mode:"swarm",roles:["Map the relevant source owners and the first useful implementation slice","Investigate independent failure cases, compatibility and boundary conditions",...(project ? ["Identify affected consumers and the smallest project checks that detect regressions"] : [])],reason:"separable investigations in a broad task",deadlineMs:30000,maxCostUsd:.03};
 return {mode:"subagent",roles:[critical ? "Investigate concrete failure cases and the checks the parent should run" : "Investigate the relevant source and return a useful next step with its verification"],reason:"one bounded independent investigation",deadlineMs:20000,maxCostUsd:.01};
}

export interface AssistanceMember {route:string;proof:string;role:string;free:boolean;explanation:string[]}
/** Every team member passes the same quality/cost gate as an ordinary child.
 * Different model identities avoid presenting duplicate routes as consensus.
 * At most one paid helper; no subscription is silently used for a swarm. */
export function selectAssistanceTeam(models: ModelInfo[], config: ModelEconomyConfig, plan: AssistancePlan, options: {freeOnly?:boolean;task?:string;minOutputTokens?:number;requiresTools?:boolean;role?:string;honorPaidPreferences?:boolean} = {}): AssistanceMember[] {
 if (!plan.roles.length) return [];
 const cheap = {...config,subscriptionProviders:[],maxInputPerMillion:Math.min(config.maxInputPerMillion,.2),maxOutputPerMillion:Math.min(config.maxOutputPerMillion,.5),operationalPremiumMaxPerMillion:undefined};
 const minOutputTokens = options.minOutputTokens ?? 1024;
 const requiresTools = options.requiresTools !== false;
 // Unknown tool support passes the pool: explicit preferences carry their own
 // positive evidence (see resolveLlmPreferenceChain), and the autonomous
 // fill below re-applies the strict positive-proof gate internally.
 const pool = models.filter(m=>(m.contextWindow??0)>=16384 && (m.maxTokens??0)>=minOutputTokens && (!requiresTools || catalogRouteCapabilities(m)?.toolCalling!==false));
 const team: AssistanceMember[] = [];
 const used = new Set<string>();
 // Explicit preferences first: distribute viable configured routes across
 // the team (distinct identities), then fill gaps with autonomous picks.
 const slots = plan.roles.slice(0,3);
 // A user free-only constraint filters configured preferences to proven-free
 // routes, matching the single-subagent path. Automatic council/review
 // rounds opt out via honorPaidPreferences: their freeOnly bounds only the
 // autonomous fill while configured routes stay honored.
 const distributed = distributeLlmPreferredModels(options.role ?? plan.mode, slots.length, pool, {requirements:{minContextWindow:16384,minOutputTokens,toolCalling:requiresTools},...(options.freeOnly && !options.honorPaidPreferences ? {freeOnly:true} : {})});
 const distinct = distributed.filter((item,index,self)=>self.findIndex(other=>modelIdentity(other.route)===modelIdentity(item.route))===index);
 slots.forEach((role,index)=>{
  const pick = distinct[index];
  if (!pick) return;
  const model = pool.find(m=>m.fullId===pick.route);
  if (!model) return;
  used.add(modelIdentity(model.id));
  team.push({route:withLlmThinkingSuffix(pick),free:isProvenFreeRoute(model),role,proof:"explicit llm_preferences",explanation:pick.explanation});
 });
 for (const role of slots.slice(team.length)) {
  const candidates = pool.filter(m=>!used.has(modelIdentity(m.id)));
  const available = (freeOnly:boolean, diverse:boolean) => selectAffordableModel(diverse ? candidates.filter(m=>!team.some(member=>member.route.startsWith(m.provider+"/"))) : candidates,cheap,
   {freeOnly,quality:{...taskQuality(options.task),level:"advisory"},requirements:{minContextWindow:16384,minOutputTokens,reasoning:false,inputModalities:["text"],toolCalling:requiresTools}});
  const freeOnly = options.freeOnly || team.some(m=>!m.free);
  const pick = available(true,true) ?? available(true,false) ?? (!freeOnly ? available(false,true) ?? available(false,false) : undefined);
  if (!pick) break;
  const model = pool.find(m=>m.fullId===pick.model)!;
  const free = isProvenFreeRoute(model);
  used.add(modelIdentity(model.id));
  team.push({route:pick.model,free,role,proof:free ? "verified free" : "known low metered price",explanation:pick.explanation});
 }
 return team;
}
