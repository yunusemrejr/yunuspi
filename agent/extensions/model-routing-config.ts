import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { builtinMediaModels, fetchMediaModels, normalizeMediaModels, type ExtensionAPI, type ExtensionContext } from "@yunuspi/coding-agent";
import { selectedMediaParams } from "./lib/media-model-routing.ts";
import { openExternal } from "./lib/project-intelligence/viewer.mjs";

/* /models edits only the media routes (image, speech, music and SFX). Language-model
 * work runs on the session's own model, so no chat role is selectable here. */

const MAX_REQUEST_BYTES = 320 * 1024;

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

// Hosted video generation is retired: a saved video choice is neither shown nor written back.
function activeMediaSelections(value: unknown) {
	const { video: _retiredVideo, ...selections } = normalizeMediaModels(value);
	return selections;
}

function mediaSnapshot(ctx: ExtensionContext) {
	const selections = activeMediaSelections(ctx.mediaModels);
	return { selections, revision: createHash("sha256").update(JSON.stringify(selections)).digest("hex"), models: builtinMediaModels().filter(row => row.kind !== "video"), writable: typeof ctx.setMediaModels === "function" };
}

function renderModelRoutingEditor(data: { media: ReturnType<typeof mediaSnapshot> }, token: string, nonce: string): string {
	const bootstrap = jsonForScript({ data, token });
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Media models · YunusPi</title><style>
:root{color-scheme:dark;--bg:#14161a;--surface:#191b20;--surface-2:#202329;--line:#30343b;--text:#e8e6e1;--muted:#a3a8b0;--accent:#ffd479;--focus:#8fd0ff;--good:#9de1bd;--bad:#ff9da7;font:14px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text)}button,input,select{font:inherit;color:inherit}button{min-height:38px;border:1px solid var(--line);border-radius:7px;background:var(--surface-2);padding:7px 11px;cursor:pointer}button:hover{border-color:#66707b;background:#292d34}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--focus);outline-offset:2px}button:disabled{opacity:.45;cursor:not-allowed}input,select{border:1px solid var(--line);border-radius:7px;background:#101216;padding:8px 10px;min-height:38px}a{color:var(--focus)}
header{display:flex;align-items:center;gap:16px;padding:17px 22px;border-bottom:1px solid var(--line);background:#17191e;position:sticky;top:0;z-index:2}header h1{font-size:18px;margin:0;font-weight:650}header .meta{color:var(--muted);font-size:12px;margin-left:auto;text-align:right}#status{font-size:12px;color:var(--muted);min-height:18px}.layout{display:grid;grid-template-columns:230px minmax(0,1fr);max-width:1280px;margin:0 auto;min-height:calc(100vh - 62px)}nav{padding:18px 12px;border-right:1px solid var(--line);background:#17191e}nav button{display:block;width:100%;text-align:left;background:transparent;border-color:transparent;margin:2px 0;min-height:42px}nav button[aria-current=true]{border-color:#4a4432;background:#28251e;color:var(--accent)}main{padding:24px;min-width:0}.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.toolbar input{flex:1;min-width:220px}.section-head{display:flex;align-items:flex-start;gap:14px;margin:0 0 14px}.section-head h2{font-size:20px;margin:0 0 4px}.section-head p{margin:0;color:var(--muted);font-size:12px}.section-head .actions{margin-left:auto;display:flex;gap:7px;flex-wrap:wrap}.notice{padding:9px 11px;border-left:3px solid var(--accent);background:#211f1a;color:#d4d0c5;margin:12px 0;font-size:12px}.notice.error{border-color:var(--bad);background:#2a1d20;color:#ffdce0}.notice.ok{border-color:var(--good);background:#1b2923;color:#c8f0d8}.route-list{margin:16px 0 24px}.route-meta{font-size:11px;color:var(--muted);margin-top:3px}.muted{color:var(--muted)}.hidden{display:none!important}
@media(max-width:760px){header{padding:13px 14px}.layout{grid-template-columns:1fr}nav{display:flex;overflow:auto;gap:4px;padding:8px;border-right:0;border-bottom:1px solid var(--line)}nav button{min-width:max-content;width:auto;padding:7px 10px}main{padding:17px 13px}.section-head{flex-direction:column}.section-head .actions{margin:0}.toolbar input{min-width:100%}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
</style></head><body><header><h1>Media models</h1><span id="status" role="status" aria-live="polite"></span><div class="meta">Image and audio choices</div></header><div class="layout"><nav id="kinds" aria-label="Media kinds"></nav><main><section id="editor"></section></main></div><script nonce="${nonce}">const BOOT=${bootstrap};</script><script nonce="${nonce}">
const state={mediaDraft:cloneMedia(BOOT.data.media?.selections),mediaLoaded:{},mediaLoading:{},mediaWarnings:{},mediaQueries:{},data:BOOT.data,token:BOOT.token,section:'image',busy:false};
function cloneMedia(value){return {...(value||{})}}
const $=(s,r=document)=>r.querySelector(s), $$=(s,r=document)=>[...r.querySelectorAll(s)];
const escapeText=x=>String(x??'');
function escAttr(x){return escapeText(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function setStatus(text,type=''){const el=$('#status');el.textContent=text;el.style.color=type==='error'?'var(--bad)':type==='ok'?'var(--good)':'var(--muted)'}
function notice(text,type=''){return '<div class="notice '+type+'">'+escAttr(text)+'</div>'}
const SECTIONS=[{id:'image',label:'Images'},{id:'audio',label:'Audio'}];
function renderSections(){const nav=$('#kinds');nav.replaceChildren();for(const section of SECTIONS){const b=document.createElement('button');b.type='button';b.textContent=section.label;b.setAttribute('aria-current',String(section.id===state.section));b.addEventListener('click',()=>{state.section=section.id;if(section.id==='image'&&!state.mediaLoaded.image&&!state.mediaLoading.image)void loadMedia('image',false);render()});nav.append(b)}}
function render(){renderSections();renderMedia()}
function mediaKinds(){return state.section==='audio'?['speech','music','sfx']:[state.section]}
function mediaLabel(kind){return ({image:'Image',speech:'Speech',music:'Music',sfx:'Sound effects'})[kind]}
function mediaFacts(row){const p=row?.capabilities?.supported_parameters||{};return [p.resolution?.values?.length?'Resolution: '+p.resolution.values.join(', '):'',p.aspect_ratio?.values?.length?'Aspect: '+p.aspect_ratio.values.join(', '):'',p.input_references?'References: '+(p.input_references.min||0)+'–'+(p.input_references.max??'?'):'',p.background?.values?.includes('transparent')?'Transparent background':''].filter(Boolean).join(' · ')}
function mediaRows(kind){const rows=(state.data.media?.models||[]).filter(row=>row.kind===kind),selected=state.mediaDraft[kind];if(selected&&!rows.some(row=>row.id===selected))rows.push({kind,id:selected,name:'Saved / custom model',description:'Availability has not been verified in the current catalog.',source:'saved choice'});return rows}
function mediaDetail(kind){const row=mediaRows(kind).find(row=>row.id===state.mediaDraft[kind]),box=$('#media-detail-'+kind);if(box)box.textContent=row?[row.description,mediaFacts(row),row.source==='live catalog'?'Public catalog; generation pricing is checked when planning a take.':''].filter(Boolean).join(' '):'Keep the existing tool and environment defaults.'}
function fillMediaSelect(kind){const select=$('#media-model-'+kind),query=(state.mediaQueries[kind]||'').toLowerCase();select.replaceChildren(new Option('Existing tool / environment default',''));for(const row of mediaRows(kind)){if(row.id!==state.mediaDraft[kind]&&query&&!((row.name+' '+row.id+' '+row.description).toLowerCase().includes(query)))continue;select.add(new Option(row.name+' · '+row.id,row.id))}select.value=state.mediaDraft[kind]||'';mediaDetail(kind)}
function renderMedia(){const kinds=mediaKinds(),title=state.section==='audio'?'Audio':mediaLabel(kinds[0])+' models';let html='<div class="section-head"><div><h2>'+escAttr(title)+'</h2><p>Choose media routes for this session or save them for future sessions.</p></div><div class="actions"><button id="media-reload" type="button">Reload choices</button><button id="media-use" type="button">Use for session</button><button id="media-save" type="button">Save media choices</button></div></div><p class="muted">Opening this page and refreshing catalogs use read-only metadata. Generation tools check capabilities and budget before a paid take; native Blender, browser recording, Piper and procedural audio use local tools.</p>';for(const kind of kinds){html+='<div class="route-list"><label for="media-model-'+kind+'"><strong>'+escAttr(mediaLabel(kind))+' model</strong></label><div class="toolbar" style="margin-top:8px"><input type="search" id="media-search-'+kind+'" aria-label="Search '+escAttr(mediaLabel(kind))+' models" placeholder="Search name, provider or capability" value="'+escAttr(state.mediaQueries[kind]||'')+'">'+(kind==='image'?'<button type="button" data-media-refresh="'+kind+'" '+(state.mediaLoading[kind]?'disabled':'')+'>'+(state.mediaLoading[kind]?'Loading catalog…':'Refresh catalog')+'</button>':'')+'</div><select style="width:100%;margin-top:10px" id="media-model-'+kind+'"></select><p class="route-meta" id="media-detail-'+kind+'"></p>'+(state.mediaWarnings[kind]?notice(state.mediaWarnings[kind],'error'):'')+'</div>'}if(!state.data.media?.writable)html+=notice('This session cannot update media settings. Reopen /models from the current harness.','error');$('#editor').innerHTML=html;for(const kind of kinds){fillMediaSelect(kind);$('#media-model-'+kind).addEventListener('change',event=>{if(event.target.value)state.mediaDraft[kind]=event.target.value;else delete state.mediaDraft[kind];mediaDetail(kind);setStatus('Media choice edited; use for session or save to apply.')});$('#media-search-'+kind).addEventListener('input',event=>{state.mediaQueries[kind]=event.target.value;fillMediaSelect(kind)})}$('#media-use').disabled=state.busy||!state.data.media?.writable;$('#media-save').disabled=state.busy||!state.data.media?.writable;$('#media-use').addEventListener('click',()=>void saveMedia(false));$('#media-save').addEventListener('click',()=>void saveMedia(true));$('#media-reload').addEventListener('click',()=>void reloadMedia());for(const button of $$('[data-media-refresh]'))button.addEventListener('click',()=>void loadMedia(button.dataset.mediaRefresh,true))}
async function mediaApi(endpoint,body){const response=await fetch('/'+state.token+'/api/'+endpoint,{method:'POST',headers:{'content-type':'application/json','x-model-routing-token':state.token},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.reason||result.error||'Media settings request failed.');return result}
async function loadMedia(kind,refresh){state.mediaLoading[kind]=true;state.mediaLoaded[kind]=true;try{const result=await mediaApi('media-catalog',{kind,refresh});state.data.media.models=[...(state.data.media.models||[]).filter(row=>row.kind!==kind),...result.models];state.mediaWarnings[kind]=result.warning||''}catch(error){state.mediaWarnings[kind]=error.message}finally{state.mediaLoading[kind]=false;if(mediaKinds().includes(kind))renderMedia()}}
async function reloadMedia(){try{const result=await mediaApi('media-snapshot',{});state.data.media={...result,models:state.data.media.models};state.mediaDraft=cloneMedia(result.selections);renderMedia();setStatus('Current media choices loaded.','ok')}catch(error){setStatus(error.message,'error')}}
async function saveMedia(persist){if(state.busy)return;state.busy=true;const selections=cloneMedia(state.mediaDraft);renderMedia();setStatus(persist?'Saving media choices…':'Applying media choices…');try{const result=await mediaApi('media-save',{selections,persist,revision:state.data.media.revision});state.data.media={...result,models:state.data.media.models};state.mediaDraft=cloneMedia(result.selections);setStatus(persist?'Media choices saved for future sessions.':'Media choices applied to this session.','ok')}catch(error){setStatus(error.message,'error')}finally{state.busy=false;renderMedia()}}
render();
</script></body></html>`;
}

function isSameOriginRequest(req: IncomingMessage, host: string, origin: string, token: string): boolean {
	return safeHost(req, host) && req.headers.origin === origin && req.headers["x-model-routing-token"] === token
		&& (!req.headers["sec-fetch-site"] || req.headers["sec-fetch-site"] === "same-origin");
}

export interface ModelRoutingEditorServerOptions {
	mediaCatalogLoader?: typeof fetchMediaModels;
	mediaTimeoutMs?: number;
}

export interface ModelRoutingEditorServer {
	server: ReturnType<typeof createServer>;
	url: string;
	close(): Promise<void>;
}

/** Production server factory, also used by UI tests with an injected media catalog loader. It never opens a browser itself. */
export async function createModelRoutingEditorServer(
	ctx: ExtensionContext,
	options: ModelRoutingEditorServerOptions = {},
): Promise<ModelRoutingEditorServer> {
	const mediaCatalogLoader = options.mediaCatalogLoader ?? fetchMediaModels;
	const mediaAbort = new AbortController();
	const mediaTimeoutMs = Math.max(50, Math.min(15_000, options.mediaTimeoutMs ?? 15_000));
	const token = randomBytes(32).toString("hex");
	const nonce = randomBytes(18).toString("base64url");
	let origin = "";
	let host = "";
	const server = createServer((req, res) => {
		void (async () => {
			const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
			if (req.method === "GET" && path === `/${token}`) {
				if (!safeHost(req, host)) return send(res, 403, { error: "Host rejected." });
				const html = renderModelRoutingEditor({ media: mediaSnapshot(ctx) }, token, nonce);
				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
				res.end(html); return;
			}
			if (!isSameOriginRequest(req, host, origin, token)) return send(res, 403, { error: "Request capability or origin rejected." });
			if (req.method !== "POST" || ![`/${token}/api/media-save`, `/${token}/api/media-catalog`, `/${token}/api/media-snapshot`].includes(path)) return send(res, 404, { error: "Not found." });
			if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) return send(res, 415, { error: "JSON content type required." });
			const body = await readJson(req) as any;
			if (path === `/${token}/api/media-snapshot`) return send(res, 200, mediaSnapshot(ctx));
			if (path === `/${token}/api/media-catalog`) {
				if (body?.kind !== "image") return send(res, 400, { error: "Catalog kind must be image." });
				const base = builtinMediaModels().filter(row => row.kind === body.kind);
				if (process.env.PI_OFFLINE === "1") return send(res, 200, { models: base, warning: "Offline mode: showing local routes and saved choices." });
				const controller = new AbortController();
				const signal = AbortSignal.any([controller.signal, mediaAbort.signal]);
				let timeout: ReturnType<typeof setTimeout> | undefined;
				try {
					const rows = await Promise.race([
						mediaCatalogLoader(body.kind, { signal, refresh: body.refresh === true }),
						new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error("Media catalog lookup timed out; saved choices remain available.")); }, mediaTimeoutMs); timeout.unref?.(); }),
					]);
					return send(res, 200, { models: [...base, ...rows.slice(0, 1000)] });
				} catch (error) { return send(res, 200, { models: base, warning: error instanceof Error ? error.message.slice(0, 240) : "Media catalog unavailable." }); }
				finally { if (timeout) clearTimeout(timeout); }
			}
			// media-save: the only remaining endpoint.
			const current = mediaSnapshot(ctx);
			if (!current.writable) return send(res, 409, { error: "Media choices are not writable in this session." });
			if (body?.revision !== current.revision) return send(res, 409, { error: "Media choices changed in this session. Reload choices before saving." });
			if (typeof body.persist !== "boolean" || !body.selections || typeof body.selections !== "object" || Array.isArray(body.selections)) return send(res, 400, { error: "Valid selections and persistence mode are required." });
			// A stale page may still submit a retired video choice; it is ignored rather than rejected.
			const { video: _retiredVideo, ...submitted } = body.selections;
			const selections = normalizeMediaModels(submitted);
			if (Object.keys(submitted).length !== Object.keys(selections).length) return send(res, 400, { error: "Unknown media kind or invalid provider-qualified model ID." });
			for (const [kind, id] of Object.entries(selections)) {
				selectedMediaParams({}, kind, { [kind]: id });
				if (id.startsWith("local/") && !builtinMediaModels().some(row => row.kind === kind && row.id === id)) return send(res, 400, { error: "Unknown local media route." });
			}
			await ctx.setMediaModels(selections, { persist: body.persist });
			return send(res, 200, mediaSnapshot(ctx));
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
			mediaAbort.abort();
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
		description: "Choose image, speech, music and SFX models.",
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
