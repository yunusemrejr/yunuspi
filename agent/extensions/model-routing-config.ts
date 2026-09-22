import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ExtensionAPI, ExtensionContext } from "@yunuspi/coding-agent";
import { openExternal } from "./lib/project-intelligence/viewer.mjs";
import { scoreModelRoutingSearch, modelRoutingProviderHints, readModelRoutingSnapshot, saveModelRoutingSnapshot } from "./lib/model-routing-store.ts";
import { fetchEndpoints, type Endpoint } from "./pi-subagents/src/runs/shared/openrouter-endpoints.ts";
import { resolveLlmPreferenceChain, resolvePromptAnalysisPreferenceChain } from "./pi-subagents/src/runs/shared/model-fallback.ts";
import { llmPreferencesPath, normalizePreferenceRole, providerOptionsToRouting } from "./pi-subagents/src/runs/shared/llm-preferences.ts";
import { toModelInfo } from "./pi-subagents/src/shared/model-info.ts";
import { getModelRoutingMetrics, recordModelRoutingLatency } from "./lib/model-routing-metrics.ts";

const BUILTIN_ROLES = [
	{ id: "subagents", label: "Subagents", detail: "Default child-agent model priority." },
	{ id: "swarm", label: "Swarm", detail: "Models used by swarm workers." },
	{ id: "fusion", label: "Fusion", detail: "Models used for independent branches and synthesis." },
	{ id: "council", label: "Councils", detail: "Models used for council members." },
	{ id: "quality_review", label: "Quality Reviews", detail: "Models used for quality-review rounds." },
	{ id: "project_review", label: "Project Reviews", detail: "Models used for project reviews." },
	{ id: "error_review", label: "Bug / Error Reviews", detail: "Models used for bug and error analysis." },
	{ id: "prompt_analysis", label: "Prompt Analysis", detail: "Low-cost routes for initial and follow-up intent analysis." },
	{ id: "main_session_fallback", label: "Main Session Fallback", detail: "Used when the saved main-session model is unavailable." },
];

const MAX_REQUEST_BYTES = 320 * 1024;
const ENDPOINT_CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const ENDPOINT_CACHE_MAX = 256;

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store, max-age=0",
		"X-Content-Type-Options": "nosniff",
		...extra,
	});
	res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const declared = Number(req.headers["content-length"] ?? 0);
		let settled = false;
		// Draining instead of destroying lets the caller answer with a real
		// status; destroying the socket would surface as a client ECONNRESET.
		const tooLarge = () => {
			if (settled) return;
			settled = true;
			const error = new Error("Request is too large.") as Error & { statusCode?: number };
			error.statusCode = 413;
			reject(error);
			req.resume();
		};
		if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) { tooLarge(); return; }
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			if (settled) return;
			size += chunk.byteLength;
			if (size > MAX_REQUEST_BYTES) { tooLarge(); return; }
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (settled) return;
			settled = true;
			try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
			catch { reject(new Error("Request body must be valid JSON.")); }
		});
		req.on("error", (error) => { if (!settled) { settled = true; reject(error); } });
	});
}

function jsonForScript(value: unknown): string {
	return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function safeHost(req: IncomingMessage, host: string): boolean { return req.headers.host === host; }

function registryModels(ctx: ExtensionContext, configPath = llmPreferencesPath()) {
	return readModelRoutingSnapshot(configPath, ctx.modelRegistry as any);
}

function rolesFor(snapshot: ReturnType<typeof registryModels>) {
	const ids = new Set(BUILTIN_ROLES.map(role => role.id));
	for (const key of Object.keys(snapshot.document?.preferences ?? {})) {
		const id = normalizePreferenceRole(key);
		if (id) ids.add(id);
	}
	return [...ids].map(id => BUILTIN_ROLES.find(role => role.id === id) ?? { id, label: id.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase()), detail: "Specialized model role already present in the canonical configuration." });
}

function resolutionFor(ctx: ExtensionContext, role: string, configPath = llmPreferencesPath()) {
	let available: ReturnType<typeof toModelInfo>[] = [];
	try { available = (ctx.modelRegistry.getAvailable?.() ?? []).map(toModelInfo); } catch { available = []; }
	const skipped: Array<{ role: string; priority: number; route: string; reason: string }> = [];
	const options = { configPath, onSkip: (event: typeof skipped[number]) => skipped.push(event) };
	if (role === "prompt_analysis") {
		const result = resolvePromptAnalysisPreferenceChain(available, { requirements: { inputModalities: ["text"], minContextWindow: 4096 }, ...options });
		return { source: result.source, skipped, routes: result.routes.map(route => ({ route: route.route, providerRouting: route.providerRouting, explanation: route.explanation })) };
	}
	const routes = resolveLlmPreferenceChain(role, available, options);
	return { source: routes.length ? role : "autonomous", skipped, routes: routes.map(route => ({ route: route.route, providerRouting: route.providerRouting, explanation: route.explanation })) };
}


function snapshotForPage(ctx: ExtensionContext, configPath = llmPreferencesPath(), resolver = resolutionFor) {
	const data = registryModels(ctx, configPath);
	const resolvedByRole: Record<string, ReturnType<typeof resolutionFor>> = {};
	for (const role of rolesFor(data)) {
		try { resolvedByRole[role.id] = resolver(ctx, role.id, configPath); }
		catch { resolvedByRole[role.id] = { source: "autonomous", routes: [] }; }
	}
	const routingByRole: Record<string, Array<Record<string, unknown> | undefined>> = {};
	for (const [key, spec] of Object.entries(data.document?.preferences ?? {})) {
		const role = normalizePreferenceRole(key);
		if (!role) continue;
		const list = Array.isArray(spec) ? spec : (spec as any)?.models;
		routingByRole[role] = (Array.isArray(list) ? list : []).map(raw => {
			const entry = typeof raw === "string" ? (data.document?.models as any)?.[raw.trim()] : raw;
			return providerOptionsToRouting(entry?.provider_options, String(entry?.provider ?? "").toLowerCase()).routing;
		});
	}
	return { ...data, roles: rolesFor(data), resolvedByRole, routingByRole, routingMetrics: getModelRoutingMetrics() };
}

export function renderModelRoutingEditor(data: ReturnType<typeof snapshotForPage>, token: string, nonce: string): string {
	const bootstrap = jsonForScript({ data, token });
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Model routing · YunusPi</title><style>
:root{color-scheme:dark;--bg:#14161a;--surface:#191b20;--surface-2:#202329;--line:#30343b;--text:#e8e6e1;--muted:#a3a8b0;--accent:#ffd479;--focus:#8fd0ff;--good:#9de1bd;--bad:#ff9da7;font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}button,input,select{font:inherit;color:inherit}button{min-height:38px;border:1px solid var(--line);border-radius:7px;background:var(--surface-2);padding:7px 11px;cursor:pointer}button:hover{border-color:#66707b;background:#292d34}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--focus);outline-offset:2px}button:disabled{opacity:.45;cursor:not-allowed}input,select{border:1px solid var(--line);border-radius:7px;background:#101216;padding:8px 10px;min-height:38px}a{color:var(--focus)}
header{display:flex;align-items:center;gap:16px;padding:17px 22px;border-bottom:1px solid var(--line);background:#17191e;position:sticky;top:0;z-index:2}header h1{font-size:18px;margin:0;font-weight:650}header .meta{color:var(--muted);font-size:12px;margin-left:auto;text-align:right}#status{font-size:12px;color:var(--muted);min-height:18px}.layout{display:grid;grid-template-columns:230px minmax(0,1fr);max-width:1280px;margin:0 auto;min-height:calc(100vh - 62px)}nav{padding:18px 12px;border-right:1px solid var(--line);background:#17191e}nav button{display:block;width:100%;text-align:left;background:transparent;border-color:transparent;margin:2px 0;min-height:42px}nav button[aria-current=true]{border-color:#4a4432;background:#28251e;color:var(--accent)}main{padding:24px;min-width:0}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.toolbar input{flex:1;min-width:220px}.section-head{display:flex;align-items:flex-start;gap:14px;margin:0 0 14px}.section-head h2{font-size:20px;margin:0 0 4px}.section-head p{margin:0;color:var(--muted);font-size:12px}.section-head .actions{margin-left:auto;display:flex;gap:7px;flex-wrap:wrap}.notice{padding:9px 11px;border-left:3px solid var(--accent);background:#211f1a;color:#d4d0c5;margin:12px 0;font-size:12px}.notice.error{border-color:var(--bad);background:#2a1d20;color:#ffdce0}.notice.ok{border-color:var(--good);background:#1b2923;color:#c8f0d8}.route-list{margin:16px 0 24px}.route-row{display:grid;grid-template-columns:30px minmax(170px,1fr) minmax(170px,1.2fr) auto;gap:10px;align-items:center;padding:12px 10px;border-bottom:1px solid #292c32}.rank{color:var(--accent);font-weight:700;text-align:center}.route-name{font-weight:650;overflow-wrap:anywhere}.route-id{font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;color:#d3d5d9;overflow-wrap:anywhere}.route-meta{font-size:11px;color:var(--muted);margin-top:3px}.row-actions{display:flex;gap:5px;justify-content:flex-end;flex-wrap:wrap}.small{font-size:11px;min-height:32px;padding:5px 8px}.settings{grid-column:2/5;display:flex;gap:9px;align-items:center;flex-wrap:wrap;padding:7px 0 1px 40px;color:var(--muted);font-size:12px}.settings label{display:flex;align-items:center;gap:6px}.settings input[type=text]{width:min(320px,42vw);min-height:33px;font-size:12px}.settings select{min-height:33px;padding:5px 8px;font-size:12px}.settings input[type=checkbox]{min-height:auto}.search-results{margin-top:15px}.result{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px;padding:10px 8px;border-bottom:1px solid #292c32}.result-main{min-width:0}.result-title{font-weight:650}.result-route{font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere;color:#c8ccd2}.result-meta{font-size:11px;color:var(--muted);margin-top:3px}.badge{display:inline-block;color:#c8ccd2;border:1px solid #40454e;border-radius:5px;padding:1px 6px;font-size:10px;margin-left:5px}.badge.good{border-color:#315d4a;color:var(--good)}.diagnostics{margin-top:24px;padding-top:14px;border-top:1px solid var(--line)}.diagnostics h3{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 8px}.diagnostics ol{margin:0;padding-left:24px;color:#c8ccd2;font-size:12px}.diagnostics li{padding:3px 0}.diagnostics summary{cursor:pointer;color:var(--muted);margin-bottom:9px}#routing-metrics dl{display:grid;grid-template-columns:minmax(110px,160px) minmax(0,1fr);gap:5px 14px;font-size:12px;color:#c8ccd2}#routing-metrics dt{color:var(--muted)}#routing-metrics dd{margin:0;overflow-wrap:anywhere}.empty{padding:15px 2px;color:var(--muted);font-size:13px}.warning{color:#ffd9a0}.muted{color:var(--muted)}.hidden{display:none!important}.danger{border-color:#74464a;color:#ffb8bd}.first{color:var(--accent);font-size:10px;text-transform:uppercase;letter-spacing:.04em;margin-left:7px}
@media(max-width:760px){header{padding:13px 14px}.layout{grid-template-columns:1fr}nav{display:flex;overflow:auto;gap:4px;padding:8px;border-right:0;border-bottom:1px solid var(--line)}nav button{min-width:max-content;width:auto;padding:7px 10px}main{padding:17px 13px}.route-row{grid-template-columns:24px minmax(0,1fr);gap:7px}.route-row>.route-meta{grid-column:2;overflow-wrap:anywhere;line-height:1.45}.route-row>.row-actions{grid-column:2;justify-content:flex-start}.settings{grid-column:1/3;padding-left:31px}.section-head{flex-direction:column}.section-head .actions{margin:0}.toolbar input{min-width:100%}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
</style></head><body><header><h1>Model routing</h1><span id="status" role="status" aria-live="polite"></span><div class="meta">Canonical JSON · saved changes apply to new agents and auxiliary requests</div></header><div class="layout"><nav id="roles" aria-label="Model roles"></nav><main><section id="editor"></section></main></div><script nonce="${nonce}">const BOOT=${bootstrap};</script><script nonce="${nonce}">
const state={data:BOOT.data,token:BOOT.token,role:'subagents',replaceIndex:null,busy:false,query:'',searchRows:[],searchGeneration:0,searchTimer:null,searchWarning:''};
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const clone=x=>structuredClone(x), escapeText=x=>String(x??'');
function escAttr(x){return escapeText(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function currentDoc(){return state.data.document||{version:1,models:{},preferences:{}}}
function configRoleKey(doc,id){const keys=Object.keys(doc.preferences||{});return keys.find(key=>canonicalRole(key)===id)||id}
function roleId(x){return String(x).trim().toLowerCase().replace(/[-_\\s]+/g,'')}
const canonicalRole=x=>({main:'main_session_fallback',mainfallback:'main_session_fallback',mainsessionfallback:'main_session_fallback',subagent:'subagents',swarms:'swarm',councils:'council',qualityreview:'quality_review',qualityreviews:'quality_review',projectreview:'project_review',projectreviews:'project_review',errorreview:'error_review',errorreviews:'error_review',bugreview:'error_review',bugreviews:'error_review',promptanalysis:'prompt_analysis',initialintentanalysis:'prompt_analysis',followupintentanalysis:'prompt_analysis'}[roleId(x)]||roleId(x));
function listFor(doc,role){const key=configRoleKey(doc,role);const spec=doc.preferences?.[key];return Array.isArray(spec)?spec.slice():Array.isArray(spec?.models)?spec.models.slice():[]}
function routeEntry(doc,item){if(typeof item==='string')return {alias:item,entry:doc.models?.[item.trim()],raw:item};return {entry:item&&typeof item==='object'?item:{},raw:item}}
function rowRoute(doc,item){const x=routeEntry(doc,item),e=x.entry||{};return {raw:x.raw,entry:e,alias:x.alias,provider:String(e.provider||''),model:String(e.model||''),fullId:e.provider&&e.model?e.provider+'/'+e.model:(x.alias?'Unknown alias: '+x.alias:'Invalid route')}}
function setStatus(text,type=''){const el=$('#status');el.textContent=text;el.style.color=type==='error'?'var(--bad)':type==='ok'?'var(--good)':'var(--muted)'}
function notice(text,type=''){return '<div class="notice '+type+'">'+escAttr(text)+'</div>'}
function roleLabel(id){return state.data.roles.find(x=>x.id===id)?.label||id.replace(/_/g,' ')}
function renderRoles(){const nav=$('#roles');nav.replaceChildren();for(const role of state.data.roles){const b=document.createElement('button');b.type='button';b.textContent=role.label;b.setAttribute('aria-current',String(role.id===state.role));b.addEventListener('click',()=>{state.role=role.id;state.replaceIndex=null;state.query='';state.searchGeneration++;clearTimeout(state.searchTimer);render()});nav.append(b)}}
function entryDisplay(doc,raw,index){const r=rowRoute(doc,raw),m=state.data.models.find(x=>x.fullId.toLowerCase()===r.fullId.toLowerCase());return {r,m,index}}
function aliasesFor(model,doc){const out=[];for(const [alias,value] of Object.entries(doc.models||{})){if(value?.provider?.toLowerCase()===model.provider.toLowerCase()&&value?.model?.toLowerCase()===model.id.toLowerCase())out.push(alias);if(value?.provider_options?.order?.length){} }return out}
function existingPins(model,doc){const out=[];for(const value of Object.values(doc.models||{})){if(value?.provider?.toLowerCase()===model.provider.toLowerCase()&&value?.model?.toLowerCase()===model.id.toLowerCase())out.push(...(value?.provider_options?.order||[]),...(value?.provider_options?.only||[]))}for(const role of Object.keys(doc.preferences||{}))for(const raw of listFor(doc,canonicalRole(role))){const e=rowRoute(doc,raw).entry;if(e?.provider?.toLowerCase()===model.provider.toLowerCase()&&e?.model?.toLowerCase()===model.id.toLowerCase())out.push(...(e?.provider_options?.order||[]),...(e?.provider_options?.only||[]))}return [...new Set(out.filter(x=>typeof x==='string'))]}
function stableRouting(value){if(Array.isArray(value))return '['+value.map(stableRouting).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stableRouting(value[key])).join(',')+'}';return JSON.stringify(value??null)}
function pinSummary(routing){if(!routing||typeof routing!=='object')return 'Provider routing: automatic';if(Array.isArray(routing.only)&&routing.only.length)return 'Pinned to '+routing.only.join(', ');if(Array.isArray(routing.order)&&routing.order.length)return 'Preferred backends: '+routing.order.join(' → ');return 'Provider routing: '+JSON.stringify(routing)}
function formatResolution(role){const info=state.data.resolvedByRole?.[role]||{source:'autonomous',routes:[]};if(role==='prompt_analysis'&&info.source==='subagents')return 'No explicit Prompt Analysis list; inheriting Subagents priority. Reset returns to this behavior.';if(info.source==='autonomous')return 'No viable configured route. Existing model selection applies.';return 'Effective source: '+(info.source==='prompt_analysis'?'Prompt Analysis':roleLabel(info.source))}
function renderRouteRows(doc,list){if(!list.length)return '<div class="empty">No configured priorities. The existing autonomous selection applies.</div>';return list.map((raw,index)=>{const {r,m}=entryDisplay(doc,raw,index),entry=r.entry||{},opts=entry.provider_options||{},mode=String(opts.routing||'auto').toLowerCase(),slugs=(Array.isArray(opts.order)?opts.order:Array.isArray(opts.only)?opts.only:[]).filter(x=>typeof x==='string').join(', '),resolved=state.data.resolvedByRole?.[state.role]?.routes||[],effectiveRouting=state.data.routingByRole?.[state.role]?.[index],isLive=resolved.some(x=>x.route.toLowerCase()===r.fullId.toLowerCase()&&stableRouting(x.providerRouting)===stableRouting(effectiveRouting));const meta=m?[(m.enabled?'Available in this session':'Catalog route; not enabled here'),m.providerHost?m.providerHost:null,m.contextWindow?m.contextWindow.toLocaleString()+' context':null,m.reasoning===true?'reasoning':null].filter(Boolean).join(' · '):'Not in the current model registry';const custom=mode==='custom',pinned=mode==='pinned';return '<div class="route-row" data-index="'+index+'" data-route="'+escAttr(r.fullId)+'"><div class="rank">'+(index+1)+'</div><div><div class="route-name">'+escAttr(m?.name||r.model||r.fullId)+(index===0?'<span class="first">first choice</span>':'')+'</div><div class="route-id">'+escAttr(r.fullId)+'</div><div class="route-meta">'+escAttr(meta)+(r.alias?' · alias '+escAttr(r.alias):'')+'</div></div><div class="route-meta">'+escAttr(pinSummary(effectiveRouting||m?.globalProviderRouting))+(isLive?' · resolver accepts this route':' · not in current viable chain')+'</div><div class="row-actions"><button class="small" data-action="up" aria-label="Move '+escAttr(r.fullId)+' up" '+(index===0?'disabled':'')+'>↑</button><button class="small" data-action="down" aria-label="Move '+escAttr(r.fullId)+' down" '+(index===list.length-1?'disabled':'')+'>↓</button><button class="small" data-action="replace">Replace</button><button class="small danger" data-action="remove">Remove</button></div><div class="settings">'+(r.provider.toLowerCase()==='openrouter'?'<label>Backend routing <select data-field="routing"><option value="auto" '+(mode==='auto'?'selected':'')+'>Automatic</option><option value="pinned" '+(pinned?'selected':'')+'>Pinned (no fallback)</option><option value="custom" '+(custom?'selected':'')+'>Preferred order</option></select></label><label>Provider slug(s) <input type="text" data-field="order" value="'+escAttr(slugs)+'" placeholder="Use a provider ID from /provider" '+(!custom&&!pinned?'disabled':'')+'></label><label><input type="checkbox" data-field="fallbacks" '+(effectiveRouting?.allow_fallbacks===true?'checked':'')+' '+(!custom?'disabled':'')+'> Allow fallback providers</label><span class="muted">'+(pinned?'Pinned routes always disable fallback providers.':custom?'Existing only, ignore, sort, and other provider options are preserved.':'Switch to preferred order to edit upstream preferences.')+'</span>':'')+'</div></div>'}).join('')}
function renderResults(){const box=$('#search-results');const active=document.activeElement;const activeRow=active?.closest?.('.result');const activeKey=activeRow?.dataset.key;box.replaceChildren();if(!state.query.trim())return;if(state.searchWarning){const warning=document.createElement('div');warning.className='notice warning';warning.textContent=state.searchWarning;box.append(warning)}for(const [index,item] of state.searchRows.entries()){const row=document.createElement('div');row.className='result';row.dataset.resultIndex=String(index);row.dataset.key=JSON.stringify([item.fullId,item.selectedProviderRouting||null]);const meta=[item.routeAvailability,item.providerHost,item.enabled?'available':'not enabled',item.contextWindow?item.contextWindow.toLocaleString()+' context':null,item.reasoning===true?'reasoning':null,item.cost?.knownFree?'known free':null].filter(Boolean).join(' · ');const directName=item.provider==='deepseek'?'DeepSeek Official API':item.provider==='friendli'?'FriendliAI':item.providerHost?item.provider+' · '+item.providerHost:item.provider+' direct API';const routeName=item.upstreamName?'OpenRouter → '+item.upstreamName:item.provider==='openrouter'?'OpenRouter · automatic upstream':directName;const variant=item.selectedProviderRouting?pinSummary(item.selectedProviderRouting):item.provider==='openrouter'?(item.globalProviderRouting?pinSummary(item.globalProviderRouting):'Upstream not selected'):'Official provider route';row.innerHTML='<div class="result-main"><div class="result-title">'+escAttr(item.name||item.id)+'</div><div class="result-route">'+escAttr(routeName)+' · '+escAttr(item.fullId)+'</div><div class="result-meta">'+escAttr(variant)+' · '+escAttr(meta)+'</div></div><button type="button">'+(state.replaceIndex===null?'Add':'Replace')+'</button>';row.querySelector('button').addEventListener('click',()=>void chooseModel(item));box.append(row)}if(!state.searchRows.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No matching routes. Search uses the locally available model registry and verified route metadata.';box.append(empty)}if(activeKey){const next=$$('.result',box).find(row=>row.dataset.key===activeKey)?.querySelector('button');next?.focus()}}
function render(){renderRoles();const doc=currentDoc(),role=state.role,list=listFor(doc,role),roleDef=state.data.roles.find(x=>x.id===role);const activeRoleKey=configRoleKey(doc,role),explicit=Object.hasOwn(doc.preferences||{},activeRoleKey);const effective=formatResolution(role);const reloadButton='<button type="button" id="reload">Reload latest JSON</button>';const restore=state.data.backupAvailable?'<button type="button" id="restore">Restore previous file</button>':'';let html='<div class="section-head"><div><h2>'+escAttr(roleDef?.label||role)+'</h2><p>'+escAttr(roleDef?.detail||'Specialized model role.')+'</p></div><div class="actions">'+reloadButton+'<button type="button" id="reset" '+(!state.data.ok?'disabled':'')+'>Reset role</button>'+restore+'</div></div>';
if(!state.data.ok){html+=notice('The canonical file cannot be parsed safely: '+(state.data.reason||'unknown error')+'. Editing is blocked until the previous valid file is restored.','error');$('#editor').innerHTML=html;bindCommon();return}
if(state.data.strictWriteError)html+=notice('Some existing entries are skipped by strict GUI validation: '+state.data.strictWriteError+'. Remove or repair those entries before saving.','error');
html+=notice(effective,'');if(role==='prompt_analysis'&&!explicit)html+=notice('Prompt Analysis inherits the Subagents ordered routes until you add a dedicated list. Clearing this role restores inheritance.','');
html+='<div class="route-list">'+renderRouteRows(doc,list)+'</div><div class="toolbar"><input id="search" type="search" aria-label="Search models" placeholder="Search provider, family, model, alias, API, or known pin" value="'+escAttr(state.query)+'"><button id="reload-catalog" type="button">Refresh local list</button></div><div class="search-results" id="search-results" aria-live="polite"></div><div class="diagnostics"><h3>Current resolver trace</h3>'+renderTrace(role)+'</div><details class="diagnostics" id="routing-diagnostics"><summary>Routing diagnostics</summary><div id="routing-metrics"></div><button type="button" id="refresh-diagnostics">Refresh diagnostics</button></details>';
$('#editor').innerHTML=html;bindCommon();bindRows();renderResults();renderRoutingMetrics();const search=$('#search');search.addEventListener('input',()=>{state.query=search.value;state.searchWarning='';state.searchGeneration++;clearTimeout(state.searchTimer);if(!state.query.trim()){void searchModels();return}state.searchTimer=setTimeout(()=>void searchModels(),120)});if(state.query)void searchModels();$('#reload-catalog').addEventListener('click',()=>location.reload());$('#refresh-diagnostics').addEventListener('click',()=>void refreshDiagnostics())}
function renderTrace(role){const info=state.data.resolvedByRole?.[role]||{source:'autonomous',routes:[],skipped:[]},routes=info.routes||[],skipped=info.skipped||[];const items=skipped.map(item=>'<li><strong>Priority '+escAttr(item.priority)+' skipped:</strong> <code>'+escAttr(item.route)+'</code> · '+escAttr(item.reason)+'</li>');if(!routes.length&&!items.length)return '<div class="empty">No viable configured route. The existing resolver falls back to normal model selection.</div>';for(const [index,route] of routes.entries())items.push('<li><strong>'+(index===0?'Selected when available':'Fallback '+(index+1))+':</strong> <code>'+escAttr(route.route)+'</code>'+(route.providerRouting?' · '+escAttr(pinSummary(route.providerRouting)):'')+'</li>');return '<ol>'+items.join('')+'</ol>'}
function bindCommon(){$('#reload')?.addEventListener('click',()=>void refreshLatest());$('#restore')?.addEventListener('click',()=>void save({restoreBackup:true}));$('#reset')?.addEventListener('click',()=>void edit(doc=>{const key=configRoleKey(doc,state.role);delete doc.preferences[key];return doc},'Role reset; inherited/default routing applies.'))}
function bindRows(){const root=$('#editor');for(const row of $$('.route-row',root)){const index=Number(row.dataset.index);for(const button of $$('button[data-action]',row))button.addEventListener('click',()=>void rowAction(index,button.dataset.action));for(const control of $$('[data-field]',row))control.addEventListener('change',()=>void updateRouteOption(index,row))}}
function rewriteRole(doc,newList){doc.preferences=doc.preferences&&typeof doc.preferences==='object'&&!Array.isArray(doc.preferences)?doc.preferences:{};const key=configRoleKey(doc,state.role),old=doc.preferences[key];doc.preferences[key]=Array.isArray(old)?{models:newList}:{...(old&&typeof old==='object'?old:{}),models:newList};return doc}
async function edit(mutator,success){if(state.busy)return;const doc=clone(currentDoc());let next;try{next=mutator(doc)}catch(error){setStatus(error.message,'error');return}await save({document:next},success)}
async function rowAction(index,action){const doc=clone(currentDoc()),list=listFor(doc,state.role),raw=list[index];if(action==='replace'){state.replaceIndex=index;state.query='';state.searchRows=[];render();$('#search')?.focus();setStatus('Choose a registry route to replace priority '+(index+1));return}if(action==='remove')list.splice(index,1);else if(action==='up'&&index>0)[list[index-1],list[index]]=[list[index],list[index-1]];else if(action==='down'&&index<list.length-1)[list[index+1],list[index]]=[list[index],list[index+1]];else return;rewriteRole(doc,list);await save({document:doc},action==='remove'?'Route removed and saved.':'Priority order updated and saved.')}
function mutableEntry(doc,list,index){const raw=list[index];if(typeof raw==='string'){const ref=doc.models?.[raw.trim()];if(!ref||typeof ref!=='object')throw new Error('This alias has no valid model entry. Remove it or repair the JSON manually.');list[index]=clone(ref);return list[index]}if(!list[index]||typeof list[index]!=='object')throw new Error('This route is malformed. Remove it or repair the JSON manually.');return list[index]}
async function updateRouteOption(index,row){const doc=clone(currentDoc()),list=listFor(doc,state.role),entry=mutableEntry(doc,list,index);const r=rowRoute(doc,list[index]);if(r.provider.toLowerCase()!=='openrouter')return;const mode=$('[data-field=routing]',row).value,slugs=$('[data-field=order]',row).value.split(',').map(x=>x.trim()).filter(Boolean);const allow=$('[data-field=fallbacks]',row).checked;if(mode==='pinned'&&!slugs.length){setStatus('Pinned routing needs at least one OpenRouter provider slug.','error');render();return}const old=entry.provider_options&&typeof entry.provider_options==='object'&&!Array.isArray(entry.provider_options)?entry.provider_options:{};const options={...old,routing:mode};if(mode==='pinned'||mode==='custom'){if(slugs.length)options.order=slugs;else if(mode==='custom')delete options.order}if(mode==='custom')options.allow_fallbacks=allow;entry.provider_options=options;rewriteRole(doc,list);await save({document:doc},'Provider routing saved.')}
function sameRouteEntry(doc,raw,item){const e=rowRoute(doc,raw).entry||{};return String(e.provider||'').toLowerCase()===String(item.provider||'').toLowerCase()&&String(e.model||'').toLowerCase()===String(item.model||'').toLowerCase()&&JSON.stringify(e.provider_options||null)===JSON.stringify(item.provider_options||null)}
async function chooseModel(model){const doc=clone(currentDoc()),list=listFor(doc,state.role),item={provider:model.provider,model:model.id,...(model.selectedProviderOptions?{provider_options:model.selectedProviderOptions}:model.selectedProviderRouting?{provider_options:{routing:'pinned',order:model.selectedProviderRouting.order||model.selectedProviderRouting.only}}:{})};const replaceAt=state.replaceIndex;const duplicateIndex=list.findIndex((raw,index)=>index!==replaceAt&&sameRouteEntry(doc,raw,item));if(duplicateIndex>=0){state.replaceIndex=null;setStatus('That exact route is already priority '+(duplicateIndex+1)+' in '+roleLabel(state.role)+'.','error');render();return}if(replaceAt!==null){const old=rowRoute(doc,list[replaceAt]).entry;list[replaceAt]={...(old&&typeof old==='object'?old:{}),...item};if(!model.selectedProviderRouting)delete list[replaceAt].provider_options;state.replaceIndex=null}else{list.push(item)}rewriteRole(doc,list);await save({document:doc},'Route saved to '+roleLabel(state.role)+'.')}
function captureFocus(){const active=document.activeElement;if(!active||!$('#editor').contains(active))return null;if(active.id==='search')return {kind:'search'};const route=active.closest('.route-row');if(route)return {kind:'route',fullId:route.dataset.route,action:active.dataset.action,field:active.dataset.field};const result=active.closest('.result');if(result)return {kind:'result',key:result.dataset.key};return null}
function restoreFocus(target){if(!target)return;if(target.kind==='search'){$('#search')?.focus();return}if(target.kind==='result'){const row=$$('.result').find(item=>item.dataset.key===target.key);row?.querySelector('button')?.focus();return}if(target.kind==='route'){let row=$$('.route-row').find(item=>item.dataset.route===target.fullId);if(!row){const rows=$$('.route-row');row=rows[Math.min(rows.length-1,0)]}let control=target.action?row?.querySelector('[data-action="'+target.action+'"]'):target.field?row?.querySelector('[data-field="'+target.field+'"]'):undefined;if(control?.disabled)control=undefined;(control||row?.querySelector('button:not(:disabled)')||$('#search'))?.focus()}}
function latencyLabel(series){if(!series||!series.sampleCount)return 'No samples';const f=n=>Number.isFinite(n)?Number(n).toFixed(1):'—';return f(series.lastMs)+' ms last · '+f(series.meanMs)+' ms mean · '+f(series.p95Ms)+' ms p95 · '+series.sampleCount+' recent samples'}
function fallbackSummary(r){const parts=[(r.from?r.from+' → ':'')+r.to,'role '+(r.source||'unknown')];if(r.provider)parts.push('provider '+r.provider);if(r.upstream)parts.push('upstream '+r.upstream);return parts.join(' · ')}
function renderRoutingMetrics(){const box=$('#routing-metrics');if(!box)return;const m=state.data.routingMetrics||{},r=m.routes||{},l=m.latency||{};box.innerHTML='<dl><dt>Config load</dt><dd>'+escAttr(latencyLabel(l.configLoad))+'</dd><dt>Config save</dt><dd>'+escAttr(latencyLabel(l.configSave))+'</dd><dt>Model search</dt><dd>'+escAttr(latencyLabel(l.search))+'</dd><dt>Route retries</dt><dd>'+escAttr((r.fallbacks||0)+' of '+(r.attempts||0)+' attempts ('+(r.fallbackPercent||0)+'%)')+'</dd></dl>'+(r.lastFallback?'<p class="muted">Latest fallback: '+escAttr(fallbackSummary(r.lastFallback))+'</p>':'')}
async function refreshDiagnostics(){const button=$('#refresh-diagnostics');if(button)button.disabled=true;try{const response=await fetch('/'+state.token+'/api/metrics',{method:'POST',headers:{'content-type':'application/json','x-model-routing-token':state.token},body:'{}'});if(!response.ok)throw new Error('Could not refresh routing diagnostics.');const result=await response.json();state.data.routingMetrics=result.routingMetrics;renderRoutingMetrics();setStatus('Routing diagnostics refreshed.','ok')}catch(error){setStatus(error.message,'error')}finally{if(button)button.disabled=false}}
async function refreshLatest(){try{setStatus('Reloading canonical JSON…');const response=await fetch('/'+state.token+'/api/snapshot',{method:'POST',headers:{'content-type':'application/json','x-model-routing-token':state.token},body:'{}'});if(!response.ok)throw new Error('Could not reload the latest JSON.');state.data=await response.json();state.searchRows=[];state.searchWarning='';state.searchGeneration++;render();setStatus('Latest JSON loaded.','ok')}catch(error){setStatus(error.message,'error')}}
async function searchModels(){const generation=++state.searchGeneration,query=state.query.trim(),role=state.role;if(!query){state.searchRows=[];renderResults();return}try{const response=await fetch('/'+state.token+'/api/search',{method:'POST',headers:{'content-type':'application/json','x-model-routing-token':state.token},body:JSON.stringify({query,role})});if(!response.ok)throw new Error('Search request failed.');const result=await response.json();if(generation!==state.searchGeneration||query!==state.query.trim()||role!==state.role)return;state.searchRows=result.models||[];state.searchWarning=result.endpointWarning||'';state.data.routingMetrics=result.routingMetrics;renderResults();renderRoutingMetrics()}catch(error){if(generation===state.searchGeneration)setStatus(error.message,'error')}}
async function save(payload,success){if(state.busy)return;const focus=captureFocus();state.busy=true;setStatus('Saving…');try{const response=await fetch('/'+state.token+'/api/save',{method:'POST',headers:{'content-type':'application/json','x-model-routing-token':state.token},body:JSON.stringify({...payload,revision:state.data.revision})});const result=await response.json();if(response.status===409||result.conflict){setStatus((result.reason||'The JSON changed outside this window.')+' Click “Reload latest JSON” to review the external edit before continuing.','error');const box=$('#status');box.dataset.conflict='true';return}if(!response.ok||!result.ok)throw new Error(result.reason||'Configuration could not be saved.');state.data=await fetch('/'+state.token+'/api/snapshot',{method:'POST',headers:{'content-type':'application/json','x-model-routing-token':state.token},body:'{}'}).then(r=>r.json());setStatus('Model routing configuration updated'+(success?' · '+success:''),'ok');render();restoreFocus(focus)}catch(error){setStatus(error.message,'error')}finally{state.busy=false}}
render();
</script></body></html>`;
}

function isSameOriginRequest(req: IncomingMessage, host: string, origin: string, token: string): boolean {
	return safeHost(req, host) && req.headers.origin === origin && req.headers["x-model-routing-token"] === token
		&& (!req.headers["sec-fetch-site"] || req.headers["sec-fetch-site"] === "same-origin");
}

interface RouteEvidence { aliases: string[]; pins: string[]; options: Array<Record<string, unknown>> }
function routeAliasEvidenceIndex(snapshot: ReturnType<typeof registryModels>): Map<string, RouteEvidence> {
	const index = new Map<string, RouteEvidence>();
	const get = (entry: any) => {
		if (!entry || typeof entry !== "object" || typeof entry.provider !== "string" || typeof entry.model !== "string") return undefined;
		const key = `${entry.provider}/${entry.model}`.toLowerCase();
		let evidence = index.get(key);
		if (!evidence) { evidence = { aliases: [], pins: [], options: [] }; index.set(key, evidence); }
		return evidence;
	};
	const addOptions = (evidence: RouteEvidence, entry: any) => {
		const options = entry?.provider_options;
		if (!options || typeof options !== "object" || Array.isArray(options)) return;
		evidence.options.push(options);
		for (const key of ["order", "only", "ignore"]) {
			const value = options[key];
			if (Array.isArray(value)) evidence.pins.push(...value.filter((item: unknown): item is string => typeof item === "string"));
		}
	};
	const doc = snapshot.document;
	for (const [alias, entry] of Object.entries((doc?.models ?? {}) as Record<string, any>)) {
		const evidence = get(entry); if (!evidence) continue;
		evidence.aliases.push(alias); addOptions(evidence, entry);
	}
	for (const spec of Object.values((doc?.preferences ?? {}) as Record<string, any>)) {
		const list = Array.isArray(spec) ? spec : spec?.models;
		for (const raw of Array.isArray(list) ? list : []) {
			const entry = typeof raw === "string" ? (doc?.models as any)?.[raw] : raw;
			const evidence = get(entry); if (evidence) addOptions(evidence, entry);
		}
	}
	for (const evidence of index.values()) {
		evidence.aliases = [...new Set(evidence.aliases)];
		evidence.pins = [...new Set(evidence.pins)];
	}
	return index;
}
function routeAliasEvidence(index: Map<string, RouteEvidence>, model: { provider: string; id: string }): RouteEvidence {
	return index.get(`${model.provider}/${model.id}`.toLowerCase()) ?? { aliases: [], pins: [], options: [] };
}
function pinsForHint(options: Record<string, unknown>, hints: string[]): boolean {
	const slugs = [options.order, options.only].flatMap(value => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
	const names = slugs.map(normalizeEndpointText);
	return names.some(name => hints.some(hint => name === normalizeEndpointText(hint) || name.startsWith(normalizeEndpointText(hint)) || normalizeEndpointText(hint).startsWith(name)));
}

export interface ModelRoutingEditorServerOptions {
	configPath?: string;
	endpointLoader?: (modelId: string, signal?: AbortSignal) => Promise<Endpoint[]>;
	endpointTimeoutMs?: number;
	resolveRole?: typeof resolutionFor;
}

export interface ModelRoutingEditorServer {
	server: ReturnType<typeof createServer>;
	url: string;
	close(): Promise<void>;
}

function normalizeEndpointText(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, ""); }
function endpointMatchesHint(endpoint: Endpoint, hint: string): boolean {
	const wanted = normalizeEndpointText(hint);
	const tag = normalizeEndpointText(endpoint.tag);
	const name = normalizeEndpointText(endpoint.provider_name ?? "");
	return Boolean(wanted && (tag === wanted || tag.startsWith(wanted) || name === wanted || name.includes(wanted)));
}
function endpointDisplayName(endpoint: Endpoint): string {
	if (endpoint.provider_name?.trim()) return endpoint.provider_name.trim();
	return endpoint.tag.split("/")[0]!.replace(/[-_]+/g, " ").replace(/\b\w/g, char => char.toUpperCase());
}

/** Production server factory, also used by UI tests with a temporary JSON path
 * and injected cached-registry resolver. It never opens a browser itself. */
export async function createModelRoutingEditorServer(
	ctx: ExtensionContext,
	options: ModelRoutingEditorServerOptions = {},
): Promise<ModelRoutingEditorServer> {
	const configPath = options.configPath ?? llmPreferencesPath();
	const resolver = options.resolveRole ?? resolutionFor;
	const endpointLoader = options.endpointLoader ?? fetchEndpoints;
	const token = randomBytes(32).toString("hex");
	const nonce = randomBytes(18).toString("base64url");
	let origin = "";
	let host = "";
	const endpointCache = new Map<string, { at: number; rows: Endpoint[] }>();
	const endpointTimeoutMs = Math.max(100, Math.min(30_000, Math.floor(options.endpointTimeoutMs ?? 8_000)));
	const endpointsFor = async (modelId: string): Promise<{ rows: Endpoint[]; verified: boolean }> => {
		const key = modelId.toLowerCase();
		const cached = endpointCache.get(key);
		if (cached && Date.now() - cached.at < ENDPOINT_CACHE_TTL_MS) return { rows: cached.rows, verified: true };
		const controller = new AbortController();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const rows = await Promise.race([
				endpointLoader(modelId, controller.signal),
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(() => { controller.abort(); reject(new Error("OpenRouter endpoint lookup timed out.")); }, endpointTimeoutMs);
					timeout.unref?.();
				}),
			]);
			if (Array.isArray(rows)) {
				endpointCache.set(key, { at: Date.now(), rows: rows.slice(0, 256) });
				if (endpointCache.size > ENDPOINT_CACHE_MAX) endpointCache.delete(endpointCache.keys().next().value!);
				return { rows: rows.slice(0, 256), verified: true };
			}
		} catch { /* upstream metadata is optional; the base route remains available */ }
		finally { if (timeout) clearTimeout(timeout); }
		return { rows: cached?.rows ?? [], verified: false };
	};
	const server = createServer((req, res) => {
		void (async () => {
			const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
			if (req.method === "GET" && path === `/${token}`) {
				if (!safeHost(req, host)) return send(res, 403, { error: "Host rejected." });
				const html = renderModelRoutingEditor(snapshotForPage(ctx, configPath, resolver), token, nonce);
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
				res.end(html); return;
			}
			if (!isSameOriginRequest(req, host, origin, token)) return send(res, 403, { error: "Request capability or origin rejected." });
			if (req.method !== "POST" || ![`/${token}/api/save`, `/${token}/api/search`, `/${token}/api/snapshot`, `/${token}/api/metrics`].includes(path)) return send(res, 404, { error: "Not found." });
			if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return send(res, 415, { error: "JSON content type required." });
			const body = await readJson(req) as any;
			if (path === `/${token}/api/metrics`) return send(res, 200, { routingMetrics: getModelRoutingMetrics() });
			if (path === `/${token}/api/search`) {
				const searchStarted = performance.now();
				const query = typeof body?.query === "string" ? body.query.slice(0, 256) : "";
				const snapshot = registryModels(ctx, configPath);
				// Upstream discovery is opt-in through the literal "openrouter"
				// token: without it, a provider name means that provider's direct
				// route and no endpoint lookup is performed.
				const openRouterRequested = /\bopen\s*router\b/i.test(query);
				const officialRequested = /\b(?:official|direct)\b/i.test(query);
				const hints = openRouterRequested && !officialRequested ? modelRoutingProviderHints(query) : [];
				const evidenceIndex = routeAliasEvidenceIndex(snapshot);
				const hintAliases: Record<string, string[]> = { together: ["together", "togetherai", "together ai", "together computer"], friendli: ["friendli", "friendli ai"], fireworks: ["fireworks", "fireworks ai"], deepinfra: ["deepinfra"], novita: ["novita"], nebius: ["nebius"], cerebras: ["cerebras", "cerebras ai"], cloudflare: ["cloudflare"], google: ["google"], anthropic: ["anthropic"], openai: ["openai"], mistral: ["mistral"], groq: ["groq"] };
				const upstreamTerms = [...new Set(hints.flatMap(hint => hintAliases[hint] ?? [hint]))].map(term => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
				const genericQuery = upstreamTerms ? query.replace(new RegExp(`\\b(?:${upstreamTerms})\\b`, "ig"), " ").replace(/\s+/g, " ").trim() : "";
				const ranked = snapshot.models.map(model => {
					const evidence = routeAliasEvidence(evidenceIndex, model);
					const score = Math.max(scoreModelRoutingSearch(query, model, evidence.aliases, evidence.pins), genericQuery ? scoreModelRoutingSearch(genericQuery, model, evidence.aliases, evidence.pins) : 0);
					return { model, score, evidence };
				}).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.model.fullId.localeCompare(b.model.fullId)).slice(0, hints.length ? 8 : 60);
				const variants: Array<{ model: any; score: number }> = [];
				const variantKeys = new Set<string>();
				let endpointLookupFailed = false;
				if (hints.length) {
					// Search-time upstream discovery is lazy and bounded to the top six
					// OpenRouter base matches. No route is invented without an exact
					// active endpoint tag from the upstream catalog.
					await Promise.all(ranked.filter(item => item.model.provider.toLowerCase() === "openrouter").slice(0, 6).map(async item => {
						const endpointResult = await endpointsFor(item.model.id);
						if (!endpointResult.verified) endpointLookupFailed = true;
						for (const endpoint of endpointResult.rows) {
							if (!hints.some(hint => endpointMatchesHint(endpoint, hint))) continue;
							const routing = { only: [endpoint.tag], order: [endpoint.tag], allow_fallbacks: false };
						const key = JSON.stringify([item.model.fullId, routing]);
						if (variantKeys.has(key)) continue;
						variantKeys.add(key);
						variants.push({ model: { ...item.model, upstreamName: endpointDisplayName(endpoint), upstreamTag: endpoint.tag, routeAvailability: endpointResult.verified ? "Verified in current OpenRouter endpoint registry" : "Previously verified endpoint; refresh failed", selectedProviderRouting: routing }, score: item.score + 30 });
						}
					}));
					// Saved pins remain selectable while offline. Keep their exact
					// canonical provider_options and label unverified availability.
					for (const item of ranked.filter(item => item.model.provider.toLowerCase() === "openrouter")) {
						for (const rawOptions of item.evidence.options) {
							if (!pinsForHint(rawOptions, hints)) continue;
							const routing = providerOptionsToRouting(rawOptions as any, item.model.provider).routing;
						if (!routing) continue;
						const slugs = Array.isArray(rawOptions.order) ? rawOptions.order : Array.isArray(rawOptions.only) ? rawOptions.only : [];
						const matching = slugs.filter((slug: unknown): slug is string => typeof slug === "string" && hints.some(hint => normalizeEndpointText(slug).startsWith(normalizeEndpointText(hint))));
						if (!matching.length) continue;
						const key = JSON.stringify([item.model.fullId, routing]);
						if (variantKeys.has(key)) continue;
						variantKeys.add(key);
						variants.push({ model: { ...item.model, upstreamName: matching.map(tag => tag.replace(/[-_]+/g, " ").replace(/\\b\\w/g, c => c.toUpperCase())).join(", "), upstreamTag: matching[0], routeAvailability: "Configured pin; current endpoint availability not checked", selectedProviderOptions: rawOptions, selectedProviderRouting: routing }, score: item.score + 25 });
						}
					}
				}
				const resultModels = [...variants.sort((a, b) => b.score - a.score || String(a.model.upstreamTag).localeCompare(String(b.model.upstreamTag))).map(item => item.model), ...ranked.map(item => item.model)].slice(0, 60);
				recordModelRoutingLatency("search", performance.now() - searchStarted);
				return send(res, 200, { models: resultModels, routingMetrics: getModelRoutingMetrics(), ...(endpointLookupFailed ? { endpointWarning: "Upstream endpoint lookup failed or timed out; showing configured pins and the automatic route." } : {}) });
			}
			if (path === `/${token}/api/snapshot`) return send(res, 200, snapshotForPage(ctx, configPath, resolver));
			// "missing" and "unreadable" are the only revisions a damaged or
			// oversized canonical file can report, and restoring the validated
			// backup is exactly the recovery path for those states.
			const restorable = body?.revision === "missing" || body?.revision === "unreadable";
			if (!restorable && (typeof body?.revision !== "string" || !/^[a-f0-9]{64}$/.test(body.revision))) return send(res, 400, { ok: false, reason: "A valid revision is required." });
			const result = await saveModelRoutingSnapshot(configPath, body.revision, body.document, { restoreBackup: body.restoreBackup === true });
			return send(res, result.conflict ? 409 : result.ok ? 200 : 400, result);
		})().catch(error => send(res, Number.isInteger((error as { statusCode?: number })?.statusCode) ? (error as { statusCode: number }).statusCode : 400, { error: error instanceof Error ? error.message.slice(0, 240) : "Request failed." }));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
	});
	const address = server.address();
	if (!address || typeof address === "string") { server.close(); throw new Error("Could not create the local model-routing window."); }
	host = `127.0.0.1:${address.port}`;
	origin = `http://${host}`;
	server.unref();
	return {
		server,
		url: `${origin}/${token}`,
		close: () => new Promise(resolve => {
			if (!server.listening) { resolve(); return; }
			server.close(() => resolve());
			server.closeIdleConnections?.();
			server.closeAllConnections?.();
		}),
	};
}

export default function modelRoutingConfig(pi: ExtensionAPI) {
	let active: ModelRoutingEditorServer | undefined;
	const closeActive = () => { const prior = active; active = undefined; if (prior) void prior.close(); };
	const open = async (ctx: ExtensionContext) => {
		if (!active?.server.listening) active = await createModelRoutingEditorServer(ctx);
		const error = await openExternal(active.url);
		if (typeof error === "string" && error) throw new Error(error);
	};
	pi.registerCommand("models", {
		description: "Open the graphical editor for YunusPi’s canonical role-based model routing.",
		handler: async (_args: string, ctx: ExtensionContext) => {
			if (ctx.hasUI === false) { ctx.ui.notify("The /models editor needs an interactive desktop session.", "warning"); return; }
			try {
				await open(ctx);
				ctx.ui.notify("Model routing editor opened.", "info");
			} catch (error) {
				if (!active?.server.listening) closeActive();
				ctx.ui.notify(`/models failed: ${error instanceof Error ? error.message.slice(0, 240) : String(error)}`, "error");
			}
		},
	});
	pi.on("session_start", event => { if (event.reason !== "startup") closeActive(); });
	pi.on("session_shutdown", closeActive);
}
