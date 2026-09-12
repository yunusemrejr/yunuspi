import {localReviewBreadth} from "../runs/shared/local-intent.ts";
import { routeSkills } from "../runs/shared/skill-routing.ts";
import { persistSubagentCost } from "./session-cost.ts";
import { stripAcceptanceReport } from "../runs/shared/acceptance.ts";
import { READ_ONLY_REASONING_TOOLS } from "../runs/shared/tool-budget.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { catalogRouteCapabilities, describeFreeRoutes, distributeChildren, isProvenFreeRoute, readFreeEvidence } from "../runs/shared/free-route-evidence.ts";
import { fuseChildOutputs } from "../workflows/recovery-seam.ts";
import { isAutonomousMeteredEligible, loadModelEconomyConfig, registerEconomyRequestHook } from "../runs/shared/model-economy.ts";
import { toModelInfo } from "../shared/model-info.ts";
import { selectAffordableModel } from "../runs/shared/model-selection.ts";
import { evaluateQuotaHealth } from "../runs/shared/quota-health.ts";
import { readJournalQuotaEvents } from "../runs/shared/quota-journal.ts";
// Shared fleet-wide cooldown state (fix_provider_cooldown_enforcement): the
// free group and reroute candidates must consult the same executable
// provider-health store the request gate enforces — a route another session
// (or child) has on cooldown is not a failover option.
import { classifyFailure, evaluateRoute, recordFailure } from "../runs/shared/provider-health.ts";

type Model = NonNullable<ExtensionContext["model"]>;
type Launch = (id: string, params: SubagentParamsLike, signal: AbortSignal, onUpdate: undefined, ctx: ExtensionContext) => Promise<any>;
const route = (m: Model) => `${m.provider}/${m.id}`;
/** Read-only group children need text, read tools and adequate context; no images. */
const FREE_MIN_CONTEXT = 16_384;
export const COOLDOWN_MS = 25_000;
export const RECOVERY_DEADLINE_MS = 120_000;
export const MAX_RECOVERY_ATTEMPTS = 4;
export function manualAssistanceRequested(prompt: string): boolean {
 const text = prompt.slice(0,32768).replace(/```[\s\S]*?```/g," ").replace(/^\s*>.*$/gm," ");
 return /\b(?:use|launch|run|ask|start|spawn|dispatch)\b[^.!?\n]{0,160}\b(?:subagents?|swarm|fusion|council)\b/i.test(text)
   || /\b(?:fuse|combine)\b[^.!?\n]{0,160}\b(?:models?|agents?|outputs?|results?)\b/i.test(text)
   || /\b(?:fusion|swarm|council)\s+(?:of|with|using)\b/i.test(text);
}
export function assistanceWidth(prompt: string): number {
 const text = prompt.slice(0, 32768);
 if (/\b(do not delegate|no subagents|no swarm|no fusion|without tools|no tools|only use|use only)\b/i.test(text)) return 0;
 // Explicit delegation is already handled by the parent; do not duplicate it.
 if (manualAssistanceRequested(text)) return 0;
 if (/\b(explain|what is|define|typo|rename|one.line)\b/i.test(text) && !/\b(debug|investigate|audit)\b/i.test(text)) return 0;
 if (!/\b(review|debug|research|compare|implement|investigate|audit|refactor|refine|optimize|design)\b/i.test(text)) return 0;
 if (text.length < 45) return 0;
 return /\b(independent|security|architecture|migration|concurrency|trade.offs|multiple|cross.service|correctness)\b/i.test(text) ? 2 : localReviewBreadth(text);
}
export function usefulFreeAssistance(prompt: string): boolean { return assistanceWidth(prompt) > 0; }

/** Advisory prose only: report envelopes are accounting, not review evidence. */
export function automaticHelperBody(result: any): string {
 const clean = (value: unknown) => typeof value === "string"
  ? stripAcceptanceReport(value).replace(/(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*|__)?acceptance[-_ ]+report\s*:?(?:\*\*|__)?\s*:?\s*$/i, "").trim()
  : "";
 const candidates = [result.finalOutput, result.output,
  ...(Array.isArray(result.messages) ? result.messages.filter((m: any) => m.role === "assistant").reverse().map((m: any) =>
   Array.isArray(m.content) ? m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") : "") : [])];
 const cleaned = candidates.map(clean);
 if (/^NO_USEFUL_FINDINGS[.!]?$/i.test(cleaned.find(Boolean) ?? "")) return "";
 return cleaned.find(Boolean)?.slice(0, 6000) ?? "";
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(new Error("Cancelled"));
		const abort = () => { clearTimeout(timer); reject(new Error("Cancelled")); };
		const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
		signal.addEventListener("abort", abort, { once: true });
	});
}

/** Conservative explicit constraints, recovered from native active-branch user
 * messages rather than a second policy ledger. Unknown/oversized history blocks
 * automatic model changes; the selected route can still be retried. */
function recoveryConstraints(ctx: ExtensionContext, prompt: string, primary: Model): { fixedRoute: boolean; sameModel: boolean; freeOnly: boolean; noDelegation: boolean } {
	const constraints = { fixedRoute: false, sameModel: false, freeOnly: isProvenFreeRoute(primary), noDelegation: false };
	let texts: string[] = [];
	try {
		texts = (ctx.sessionManager.getBranch?.() ?? []).flatMap((entry: any) => entry.type === "message" && entry.message?.role === "user"
			? [typeof entry.message.content === "string" ? entry.message.content : entry.message.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n") ?? ""] : []);
	} catch { constraints.fixedRoute = true; constraints.noDelegation = true; }
	texts.push(prompt);
	let bytes = 0;
	for (const text of texts) {
		bytes += text.length;
		if (bytes > 1_000_000) { constraints.fixedRoute = true; constraints.noDelegation = true; break; }
		if (/(?:^|[.!?\n])\s*(?:please\s+)?(?:now\s+)?(?:allow|enable)\s+(?:automatic\s+)?(?:model\s+)?fallback\b/i.test(text)) { constraints.fixedRoute = false; constraints.sameModel = false; }
		if (/\b(?:no|disable|do not|don't|never)\s+(?:(?:allow|enable)\s+)?(?:(?:automatic|model|provider)\s+)*fallbacks?\b|\b(?:do not|don't|never)\s+(?:switch|change)\s+(?:the\s+)?provider\b|\b(?:same|current|this)\s+provider\s+only\b/i.test(text)) constraints.fixedRoute = true;
		if (/\b(?:same|current|this)\s+model\s+only\b|\b(?:do not|don't|never)\s+(?:switch|change)\s+(?:the\s+)?model\b|\b(?:only use|use only|stick to|stay on)\b[^\n.!?]{0,160}\b(?:model|provider)\b/i.test(text)) constraints.sameModel = true;
		if (/\bfree[- ]only\b|\bonly\s+(?:use\s+)?free\b|\b(?:no|never use|do not use|don't use)\s+paid\b/i.test(text)) constraints.freeOnly = true;
		// An exclusive bare target ("only use qwen3") is still a restriction.
		// Do not guess whether it names a provider, model, or family and silently
		// replace it. "Only use free ..." remains a cost constraint, not a pin.
		for (const match of text.matchAll(/\b(?:only use|use only|stick to|stay on)\s+([^\n.!?]+)/gi)) {
			if (/^(?:the\s+)?free\b/i.test(match[1]!.trim())) constraints.freeOnly = true;
			else constraints.fixedRoute = true;
		}
		if (/(?:^|[.!?\n])\s*(?:please\s+)?(?:now\s+)?(?:allow|enable)\s+(?:automatic\s+)?(?:delegation|subagents|swarm)\b/i.test(text)) constraints.noDelegation = false;
		if (/\b(?:do not|don't|never)\s+(?:delegate|(?:allow|enable|use)\s+(?:automatic\s+)?(?:subagents|swarm|delegation))\b|\bno\s+(?:subagents|swarm|delegation)\b/i.test(text)) constraints.noDelegation = true;
	}
	return constraints;
}
/** Root lifecycle controller. Native executor owns processes, fleet slots and cancellation; one parent remains writer. */
export function registerAutonomousRecovery(pi: ExtensionAPI, launch: Launch, deps: { now?: () => number; wait?: typeof wait; childRoutes?: readonly string[] } = {}): void {
	const child = process.env.PI_SUBAGENT_CHILD === "1";
	if (child && !deps.childRoutes?.length) return;
	const now = deps.now ?? Date.now;
	const sleep = deps.wait ?? wait;
	// Bounded proactive assistance is enabled; explicit opt-out still wins.
	const freeAssistRequested = () => process.env.PI_AUTONOMOUS_FREE_ASSIST !== "0" && process.env.PI_AUTONOMOUS_FREE_ASSIST !== "off";
	const on = pi.on as (name: string, fn: (event: any, ctx: ExtensionContext) => any) => void;
	let primary: Model | undefined;
	let prompt = "";
	let skillBrief = "";
	let generation = 0;
	let usedAssist = false;
	let groupUsed = false;
	let recoveryStart: number | undefined;
	let restorePrimary = false;
	let automaticRoute: string | undefined;
	let requestedOutput: { route: string; tokens: number } | undefined;
	let attempts = 0;
	let busy = false;
	let paused = false;
	const ownSelection = new AsyncLocalStorage<boolean>();
	let active: AbortController | undefined;
	let assistance: AbortController | undefined;
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	const visited = new Set<string>();
	const exhausted = new Set<string>();
	if (!child) registerEconomyRequestHook(pi, { automaticRoute: () => automaticRoute });
	on("before_provider_request", (event, ctx) => {
		const payload = event.payload;
		if (!ctx.model || !primary || route(ctx.model) !== route(primary) || !payload || ![ctx.model.id, route(ctx.model)].includes(payload.model)) return;
		const tokens = payload.max_tokens ?? payload.max_completion_tokens ?? payload.max_output_tokens;
		if (Number.isSafeInteger(tokens) && tokens > 0) requestedOutput = { route: route(primary), tokens };
	});
	const notice = (ctx: ExtensionContext, text: string) => {
        try { (globalThis as any)[Symbol.for("yunus-pi.health.v1")]?.("recovery.notice", {outcome: /cancel|paused/i.test(text)?"paused":/failed|unavailable/i.test(text)?"unavailable":"progress"}); } catch {}
		ctx.ui.setStatus("autonomous-recovery", text);
		// Persist emission time immediately: sendMessage queues until inference resumes.
		pi.appendEntry("provider-recovery", { emittedAt: now(), check: attempts, elapsedMs: recoveryStart === undefined ? 0 : now() - recoveryStart, text });
	};
	const reset = () => { assistance?.abort(); assistance = undefined; active?.abort(); active = undefined; busy = false; if (deadlineTimer) clearTimeout(deadlineTimer); deadlineTimer = undefined; generation++; usedAssist = false; groupUsed = false; attempts = 0; recoveryStart = undefined; restorePrimary = false; automaticRoute = undefined; requestedOutput = undefined; paused = false; visited.clear(); exhausted.clear(); };
	on("input", (event, ctx) => {
		if (event.source === "extension") return;
		const keepAutomatic = automaticRoute && ctx.model && route(ctx.model) === automaticRoute;
		const previousPrimary = primary, previousAutomatic = automaticRoute;
		reset();
		primary = keepAutomatic ? previousPrimary : ctx.model;
		if (keepAutomatic) { automaticRoute = previousAutomatic; restorePrimary = true; }
		prompt = event.text;
	});
	for (const name of ["session_shutdown", "session_before_switch", "session_before_fork", "session_before_tree"]) on(name, () => { reset(); primary = undefined; prompt = ""; });
	on("model_select", (event) => {
		if (event.source === "restore" || event.source === "set" && ownSelection.getStore()) return;
		// A manual choice cancels timers and in-flight waits, and remains sticky
		// until new user input. A global changingModel flag hid concurrent cycles.
		reset(); primary = event.model; paused = true;
	});
	const setModel = async (model: Model, ctx: ExtensionContext): Promise<boolean> => {
		const epoch = generation;
		const selected = await ownSelection.run(true, () => pi.setModel(model));
		// Core validates auth asynchronously before changing models. If a manual
		// choice won meanwhile, undo only our stale write, never a newer choice.
		if (epoch !== generation && primary && ctx.model && route(ctx.model) === route(model) && route(primary) !== route(model)) await setModel(primary, ctx);
		return selected;
	};
	const available = (ctx: ExtensionContext) => {
		const scope = ctx.scopedModels?.map(x => route(x.model));
		const models = ctx.modelRegistry.getAvailable().filter(m => (!scope?.length || scope.includes(route(m))) && (!child || deps.childRoutes!.includes(route(m))));
		const health = evaluateQuotaHealth(readJournalQuotaEvents(), [...new Set(models.map(m => m.provider))], now());
		const t = now();
		// exhausted holds ROUTE keys ("provider/id") and, only for provider-scoped
		// failure classifications, bare provider keys. evaluateRoute adds the
		// SHARED cooldown state declared by any session/child (executable state,
		// not prose): a cooling route is not a failover candidate.
		return models.filter(m => !exhausted.has(m.provider) && !exhausted.has(route(m))
			&& !health.some(h => h.provider === m.provider && h.state === "exhausted")
			&& evaluateRoute({ provider: m.provider, model: m.id, now: t }).allowed);
	};
	const group = async (ctx: ExtensionContext, signal: AbortSignal, failure?: string): Promise<string | undefined> => {
		if (groupUsed) return;
		const groupEpoch = generation, groupSessionFile = ctx.sessionManager.getSessionFile();
		const models = available(ctx);
		const report = describeFreeRoutes(models, { requirements: { minContextWindow: FREE_MIN_CONTEXT, toolCalling: true }, now: now() });
		const eligible = report.candidates.filter(c => c.eligible).sort((a,b)=>(a.rank??Infinity)-(b.rank??Infinity));
		const width = failure ? 2 : assistanceWidth(prompt);
		let routes = distributeChildren(eligible, Math.min(width, eligible.length)).map(c=>({route:c.route,proof:String(c.proof)}));
		let metered = false;
		const constraints = primary ? recoveryConstraints(ctx,prompt,primary) : undefined;
		if (!routes.length && !constraints?.freeOnly) {
			const config = loadModelEconomyConfig();
			// A small advisory task must not inherit the entire general budget.
			const cheap = {...config,maxInputPerMillion:Math.min(config.maxInputPerMillion,0.2),maxOutputPerMillion:Math.min(config.maxOutputPerMillion,0.5)};
			const pool = models.map(toModelInfo).filter(m=>isAutonomousMeteredEligible(m,cheap) && (m.contextWindow ?? 0) >= FREE_MIN_CONTEXT && catalogRouteCapabilities(models.find(model=>route(model)===m.fullId)!)?.toolCalling === true);
			const pick = selectAffordableModel(pool,cheap);
			if (pick) { routes=[{route:pick.model,proof:"known low metered price and catalog tool support"}]; metered=true; }
		}
		if (!routes.length) return; // No useful eligible capacity: parent proceeds quietly.
		// Consume the one-group budget only after a route is actually admitted.
		// A transient shared cooldown, stale free catalog, or quota snapshot must
		// not prevent a later failure from using newly available cheap capacity.
		// This assignment remains before the first await, so concurrent callers
		// still coalesce into one bounded group.
		groupUsed = true;
		const metrics = (globalThis as any)[Symbol.for('yunus-pi.metrics.v1')];
		if (routes.length > 1) try { metrics?.('swarms'); } catch {}

		notice(ctx, routes.length === 2
			? `Automatic free read-only group: ${routes.map(c => c.route).join(", ")}; parent remains sole writer.`
			: `Automatic ${metered ? "low-cost" : "free"} helper: ${routes[0].route}; one read-only child, parent remains sole writer.`);
		const results = await Promise.all(routes.map(async (candidate, index) => {
			const model = models.find(m => `${m.provider}/${m.id}` === candidate.route)!;
			const key = candidate.route;
			const brief = prompt.length <= 16_000 ? prompt : `${prompt.slice(0, 8_000)}\n[Middle omitted from bounded helper brief; do not search session history.]\n${prompt.slice(-8_000)}`;
			const sessionFile = ctx.sessionManager.getSessionFile();
			const launchId = `auto-assist-${randomUUID()}`, epoch = generation;
			const ownsSession = () => {
				try { return Boolean(sessionFile && epoch === generation && ctx.sessionManager.getSessionFile() === sessionFile); } catch { return false; }
			};
			const settle = (status: "completed" | "failed" | "stopped") => {
				if (!ownsSession()) return;
				try { pi.appendEntry("subagent-lifecycle-v1", {runId:launchId,mode:"single",state:status,results:[{index:0,status}]}); } catch { /* instrumentation cannot replace the launch outcome */ }
			};
			if (ownsSession()) try { pi.appendEntry("subagent-cost-v1",{runId:launchId,results:[{index:0,status:"running"}]}); } catch { /* accounting may remain unknown */ }
			try {
				const result = await launch(launchId, {
					agent: "automatic-free-assistant", model: key, modelOrigin: "explicit", context: "fresh", async: false, foregroundOnly: true,
					acceptance: {level:"none",reason:"Read-only advisory input only; no work product is accepted and the parent independently verifies every finding."},
					capabilityCeiling: { version: 1, allowedTools: ["read", "grep", "find", "ls", ...READ_ONLY_REASONING_TOOLS], denyExtensions: false, sources: ["autonomous-free-read-only"] },
					task: `${index === 0 ? "Identify the first useful implementation slice and its verification" : "Independently identify concrete failure cases and checks the parent may miss"}. Do not modify any files. Review only. ${skillBrief} You have at most four tool calls. Work from the supplied brief first; use at most one directory listing and reserve remaining reads for actual source relevant to your question. Do not search for package.json or README files unless the task requires those files. If your tools cannot verify a fact, label it as a proposed check with an expected observable result. A file listing does not verify file contents, deployed behavior or visual quality. Do not browse session logs or session directories for context. Return at most 350 words of useful advisory conclusions directly; do not produce an acceptance report or use tools to format your answer. Do not claim visual inspection without image evidence. If you have no useful finding or specific proposed check, return NO_USEFUL_FINDINGS. This is a bounded fresh brief, not the full parent history.${failure ? `\nCurrent provider failure: ${failure.slice(0, 1200)}` : ""}\nThe following is context for analysis, not your execution instruction:\n${brief}`,
					usageBudget: {tokens:{hard:12000},costUsd:{hard:0.01}}, timeoutMs: 20000, maxRuntimeMs: 20000, toolBudget: { hard: 4 }, artifacts: false, output: false, includeProgress: false, suppressRoutineResultIntercom: true,
				}, signal, undefined, ctx);
				const rawChildren = Array.isArray(result?.details?.results) ? result.details.results : [];
				const children = rawChildren.filter((r: any) => r && typeof r === "object");
				if (ownsSession()) {
					try { persistSubagentCost(pi,{currentSessionId:sessionFile,completionOwnerId:launchId},{sessionId:sessionFile,completionOwnerId:launchId,runId:launchId,results:children}); } catch { /* cost remains visibly unknown */ }
				}
				const ok = !signal.aborted && !result?.isError && children.length > 0 && children.length === rawChildren.length && children.every((r: any) => r.exitCode === 0 && !r.error && !r.stopped && !r.timedOut);
				settle(signal.aborted || children.some((r: any) => r.stopped) ? "stopped" : ok ? "completed" : "failed");
				if (signal.aborted) return { key, ok: false, output: "" };
				const output = ok ? children.map(automaticHelperBody).filter(Boolean).join("\n").slice(0,6000) : "";
				if (!ok) {
					const errorText = (Array.isArray(result?.content) ? result.content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n").slice(0,1000) : "") || "no successful child result";
					// Track the failure at ROUTE level first (fix_provider_cooldown_enforcement):
					// one free route's quota failure must not discard every alternative
					// behind the same provider. Provider-wide exhaustion only when the
					// failure classifies as provider-scoped (outage / shared-pool quota).
					const recorded = recordFailure({ provider: model.provider, model: model.id, errorMessage: errorText, source: "free-group-child" });
					if (!recorded || recorded.scope === "route") exhausted.add(key); else exhausted.add(model.provider);
					console.warn(`[autonomous-recovery] ${key} failed: ${errorText}`);
				}
				return { key, ok, output };
			} catch (error) {
				settle(signal.aborted ? "stopped" : "failed");
				if (signal.aborted) return { key, ok: false, output: "" };
				const text = String(error).slice(0, 500);
				const recorded = recordFailure({ provider: model.provider, model: model.id, errorMessage: text, source: "free-group-child" });
				if (!recorded || recorded.scope === "route") exhausted.add(key); else exhausted.add(model.provider);
				console.warn(`[autonomous-recovery] ${key}: ${text}`);
				return { key, ok: false, output: "" };
			}
		}));
		if (signal.aborted || groupEpoch !== generation || ctx.sessionManager.getSessionFile() !== groupSessionFile) return;
		const good = results.filter(r => r.ok && r.output.trim());
		if (!good.length) { notice(ctx, "Automatic helpers returned no usable evidence; parent continues without respawning the group."); return; }
		const body = good.length === 1 ? good[0].output : fuseChildOutputs(good, { maxBodyChars: 10000 }).fusedBody;
		if (good.length > 1) try { metrics?.('fusions'); } catch {}
		return `Read-only ${metered ? "low-cost" : "free"} assistance (${good.length}/${routes.length} supplied advisory output; independently verify every claim):\n${body}`;
	};
	on("before_agent_start", async (event, ctx) => {
		primary ??= ctx.model;
		prompt ||= event.prompt;
		// Rank all applicable routes, then cap the available references. A missing
		// high-priority skill must not displace a lower-ranked installed skill.
		const wanted = new Set([...routeSkills(prompt).sort((a,b)=>b.priority-a.priority).map(r=>r.name), "evidence-first-engineering"]);
		const catalog = new Map([...String(event.systemPrompt ?? "").slice(0,262144).matchAll(/<skill>\s*<name>([^<]+)<\/name>[\s\S]*?<location>([^<]+)<\/location>\s*<\/skill>/g)]
			.filter(m=>wanted.has(m[1]) && m[2].startsWith("/") && m[2].length<512).map(m=>[m[1],m[2].replaceAll("&amp;","&")]));
		const paths = [...wanted].flatMap(name=>catalog.has(name)?[catalog.get(name)!]:[]).slice(0,2);
		skillBrief = paths.length ? `Optional skill references; read only if essential to a specific uncertainty: ${paths.map(p=>JSON.stringify(p)).join(", ")}.` : "";
		if (pi.getActiveTools && !pi.getActiveTools().includes("subagent")) return;
		if (child || !freeAssistRequested() || usedAssist || busy || !usefulFreeAssistance(prompt)) return;
		const constraints = primary ? recoveryConstraints(ctx, prompt, primary) : undefined;
		if (constraints?.noDelegation || constraints?.fixedRoute || constraints?.sameModel) return;
		usedAssist = true;
		const epoch = generation;
		const controller = assistance = new AbortController();
		const signal = ctx.signal ? AbortSignal.any([controller.signal, ctx.signal, AbortSignal.timeout(25000)]) : AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]);
		// Read-only helpers never hold up the parent's first request or own its
		// recovery lock. Native next-turn delivery does not wake an idle parent.
		void group(ctx, signal).then(content => {
			if (content && epoch === generation && !signal.aborted) pi.sendMessage({customType:"autonomous-free-fusion",content,display:true},{deliverAs:"nextTurn",triggerTurn:false});
		}).catch(error => {if(epoch===generation && !signal.aborted) console.warn("[autonomous-recovery] free assistance failed:",error);})
		.finally(()=>{controller.abort();if(assistance===controller)assistance=undefined;});
	});
	on("agent_end", () => { assistance?.abort(); assistance = undefined; });
	on("pi_provider_recovery", async (event, ctx) => {
		if (!primary) return;
		const errorText = event.message?.errorMessage ?? "";
		const failure = classifyFailure(errorText);
		// Share health classification; the gate's own denial is a wait, not a
		// new provider failure. Never reroute a deterministic content rejection.
		if (failure?.kind === "deterministic") { event.decision = "pause"; return; }
		if (!failure && !errorText.includes("provider-gate")) return;
		assistance?.abort(); assistance = undefined;
		event.decision = "pause"; // Owned errors never fall back to another retry loop.
		if (busy || paused || event.signal.aborted || event.message.content?.some((b: any) => b.type === "toolCall")) return;
		if (attempts >= MAX_RECOVERY_ATTEMPTS) {
			paused = true;
			if (deadlineTimer) clearTimeout(deadlineTimer);
			deadlineTimer = undefined;
			notice(ctx, `Recovery paused: bounded attempts exhausted (${MAX_RECOVERY_ATTEMPTS}); next user message resets it.`);
			return;
		}
		const epoch = generation;
		const controller = active = new AbortController();
		if (recoveryStart === undefined) {
			recoveryStart = now();
			deadlineTimer = setTimeout(() => { if (epoch === generation) { paused = true; active?.abort(); notice(ctx, "Recovery deadline reached; paused until next user message."); ctx.abort(); } }, RECOVERY_DEADLINE_MS);
			deadlineTimer.unref?.();
		}
		const remaining = RECOVERY_DEADLINE_MS - (now() - recoveryStart);
		if (remaining <= 0) { paused = true; notice(ctx, "Recovery paused: bounded attempts/deadline exhausted; next user message resets it."); return; }
		const signal = AbortSignal.any([event.signal, controller.signal, AbortSignal.timeout(remaining)]);
		busy = true;
		try {
			attempts++;
			visited.add(`${event.message.provider}/${event.message.model}`);
			const candidates = available(ctx);
			const cfg = loadModelEconomyConfig();
			const constraints = recoveryConstraints(ctx, prompt, primary);
			const evidence = readFreeEvidence();
			const toolsRequired = (pi.getActiveTools?.() ?? ["unknown"]).length > 0;
			const usage = ctx.getContextUsage?.()?.tokens;
			const output = requestedOutput?.route === route(primary) ? requestedOutput.tokens : primary.maxTokens;
			const compatible = constraints.fixedRoute || process.env.PI_AUTONOMOUS_MODEL_FALLBACK === "off" || Object.keys((primary as any).compat?.openRouterRouting ?? {}).length ? [] : candidates.filter(m => {
				if (![m.contextWindow, m.maxTokens, output].every(value => Number.isSafeInteger(value) && value > 0)) return false;
				// Use current work size when known, with half the destination window
				// left for system/tools/tokenizer drift. Native Pi still owns exact
				// request budgets and cross-API conversation transformation.
				const fits = Number.isSafeInteger(usage) && usage! >= 0 ? usage! + output <= m.contextWindow / 2 : m.contextWindow >= primary!.contextWindow;
				if (visited.has(route(m)) || !fits || m.maxTokens < output || primary!.reasoning && !m.reasoning || !primary!.input.every(i => m.input.includes(i))) return false;
				const free = isProvenFreeRoute(m, evidence, now());
				if (constraints.freeOnly ? !free : !free && !isAutonomousMeteredEligible(toModelInfo(m), cfg)) return false;
				if (m.id === primary!.id) return m.provider !== primary!.provider && m.api === primary!.api;
				if (constraints.sameModel) return false;
				// Cross-model recovery requires positive tool support, never guessed
				// from family names. The catalog evidence already stores paid rows.
				return !toolsRequired || catalogRouteCapabilities(m, evidence, now())?.toolCalling === true;
			});
			const sameModel = compatible.filter(m => m.id === primary!.id);
			const pool = sameModel.length ? sameModel : compatible;
			const choice = selectAffordableModel(pool.map(toModelInfo), cfg);
			const alternate = pool.find(m => route(m) === choice?.model);
			if (alternate) {
				visited.add(route(alternate));
				if (await setModel(alternate, ctx)) { if (epoch !== generation || signal.aborted) return; restorePrimary = true; automaticRoute = route(alternate); notice(ctx, `${alternate.id === primary.id ? "Provider" : "Model"} recovery: ${route(primary)} → ${route(alternate)}; ${choice!.explanation.join(" ")}; retained session and completed tool results.`); event.decision = "retry"; return; }
			}
			if (epoch !== generation || signal.aborted) return;
			// Helpful only after repeated real failure, never as a default startup
			// tax. The existing group owns free proof, fanout, read-only ceilings,
			// runtime and quota bounds; this is one advisory, not a takeover.
			if (!child && attempts >= 2 && !groupUsed && !constraints.noDelegation && !constraints.fixedRoute && !constraints.sameModel && usefulFreeAssistance(prompt)) {
				const helper = assistance = new AbortController();
				const helperSignal = AbortSignal.any([helper.signal, event.signal, AbortSignal.timeout(25000)]);
				void group(ctx, helperSignal, event.message.errorMessage).then(content => {
					if (content && epoch === generation && !helperSignal.aborted) pi.sendMessage({customType:"autonomous-free-fusion",content,display:true},{deliverAs:"nextTurn",triggerTurn:false});
				}).catch(() => {}).finally(() => {helper.abort();if(assistance===helper)assistance=undefined;});
			}
			const primaryDecision = evaluateRoute({ provider: primary.provider, model: primary.id, now: now() });
			const retryDelayMs = primaryDecision.allowed ? COOLDOWN_MS : Math.max(0, primaryDecision.waitMs);
			notice(ctx, `Recovery check ${attempts}: no unvisited compatible route with proven price/capabilities within current constraints; wait ${Math.ceil(retryDelayMs / 1000)}s before retrying the pending continuation. No separate probes or tool replay.`);
			// Wait out the SHARED executable cooldown of the primary route (not
			// just the fixed fallback): the store is fleet-visible, so the recheck
			// cannot fire into a provider another session just saw fail. Bounded by
			// the recovery deadline via the signal.
			await sleep(Math.min(retryDelayMs, RECOVERY_DEADLINE_MS - (now() - recoveryStart!)), signal);
			if (epoch !== generation || signal.aborted || now() - recoveryStart! >= RECOVERY_DEADLINE_MS) return;
			if (await setModel(primary, ctx)) { if (epoch !== generation || signal.aborted) return; automaticRoute = undefined; notice(ctx, `Primary recheck/resumption: ${route(primary)}; retained conversation and completed tool results.`); event.decision = "retry"; }
		} catch { if (epoch === generation) {
			paused = true;
			if (deadlineTimer) clearTimeout(deadlineTimer);
			deadlineTimer = undefined;
			notice(ctx, signal.aborted ? "Recovery cancelled or deadline reached; no pending autonomous jobs." : "Recovery setup failed; paused with session history retained.");
		} }
		finally { controller.abort(); if (active === controller) { active = undefined; busy = false; } }
	});
	on("agent_settled", async (_event, ctx) => {
		if (deadlineTimer) clearTimeout(deadlineTimer); deadlineTimer = undefined;
		active?.abort();
		if (restorePrimary && primary && ctx.model && route(ctx.model) !== route(primary)) await setModel(primary, ctx);
		restorePrimary = false;
		automaticRoute = undefined;
	});
	on("message_end", (event, ctx) => {
		const message = event.message;
		if (message?.role !== "assistant" || !["stop", "toolUse"].includes(message.stopReason) || !message.content?.some((b: any) => b.type === "toolCall" || b.type === "text" && b.text?.trim())) return;
		// Success ends continuous failure, even while the task continues using tools.
		if (deadlineTimer) clearTimeout(deadlineTimer);
		deadlineTimer = undefined; recoveryStart = undefined; attempts = 0; visited.clear();
		ctx.ui.setStatus("autonomous-recovery", undefined);
	});
}
