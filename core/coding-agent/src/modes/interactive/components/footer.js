import { isAbsolute, relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth } from "@yunuspi/tui";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.js";
import { addUsageToTotals, createUsageTotals } from "../../../core/usage-totals.js";
import { theme } from "../theme/theme.js";
/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text) {
    // Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
    return text
        .replace(/[\r\n\t]/g, " ")
        .replace(/ +/g, " ")
        .trim();
}
/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count) {
    if (count < 1000)
        return count.toString();
    if (count < 10000)
        return `${(count / 1000).toFixed(1)}k`;
    if (count < 1000000)
        return `${Math.round(count / 1000)}k`;
    if (count < 10000000)
        return `${(count / 1000000).toFixed(1)}M`;
    return `${Math.round(count / 1000000)}M`;
}
export function formatCwdForFooter(cwd, home) {
    if (!home)
        return cwd;
    const resolvedCwd = resolve(cwd);
    const resolvedHome = resolve(home);
    const relativeToHome = relative(resolvedHome, resolvedCwd);
    const isInsideHome = relativeToHome === "" ||
        (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
    if (!isInsideHome)
        return cwd;
    return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}
/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent {
    autoCompactEnabled = true;
    session;
    footerData;
    constructor(session, footerData) {
        this.session = session;
        this.footerData = footerData;
    }
    setSession(session) {
        this.session = session;
    }
    setAutoCompactEnabled(enabled) {
        this.autoCompactEnabled = enabled;
    }
    /**
     * No-op: git branch caching now handled by provider.
     * Kept for compatibility with existing call sites in interactive-mode.
     */
    invalidate() {
        // No-op: git branch is cached/invalidated by provider
    }
    /**
     * Clean up resources.
     * Git watcher cleanup now handled by provider.
     */
    dispose() {
        // Git watcher cleanup handled by provider
    }
    render(width) {
        const state = this.session.state;
        // Calculate cumulative usage from ALL session entries (not just post-compaction messages)
        const usageTotals = createUsageTotals();
        for (const entry of this.session.sessionManager.getEntries()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
                addUsageToTotals(usageTotals, entry.message.usage);
            }
            else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
                addUsageToTotals(usageTotals, entry.message.usage);
            }
            else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
                addUsageToTotals(usageTotals, entry.usage);
            }
        }
        // Calculate context usage from session (handles compaction correctly).
        // After compaction, tokens are unknown until the next LLM response.
        const contextUsage = this.session.getContextUsage();
        const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
        const contextPercentValue = contextUsage?.percent ?? 0;
        const contextPercent = Number.isFinite(contextUsage?.percent) ? contextPercentValue.toFixed(1) : "?";
        // Replace home directory with ~
        let pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
        // Add git branch if available
        const branch = this.footerData.getGitBranch();
        if (branch) {
            pwd = `${pwd} (${branch})`;
        }
        // Add session name if set
        const sessionName = this.session.sessionManager.getSessionName();
        if (sessionName) {
            pwd = `${pwd} • ${sessionName}`;
        }
        // Build stats line
        const statsParts = [];
        if (usageTotals.input)
            statsParts.push(`↑${formatTokens(usageTotals.input)}`);
        if (usageTotals.output)
            statsParts.push(`↓${formatTokens(usageTotals.output)}`);
        if (usageTotals.cacheRead)
            statsParts.push(`R${formatTokens(usageTotals.cacheRead)}`);
        if (usageTotals.cacheWrite)
            statsParts.push(`W${formatTokens(usageTotals.cacheWrite)}`);
        statsParts.push((function formatCacheHit(entries, model) {
  let rate, previous = false;
  for (const entry of entries) {
    if (entry.type === 'model_change') { rate = undefined; previous = false; continue; }
    const message = entry.type === 'message' ? entry.message : undefined;
    if (message?.role !== 'assistant') continue;
    if (message.provider !== model?.provider || message.model !== model?.id) { rate = undefined; previous = false; continue; }
    const usage = message.usage;
    const counters = [usage?.input, usage?.cacheRead, usage?.cacheWrite];
    const valid = counters.every(v => Number.isFinite(v) && v >= 0);
    const total = valid ? counters.reduce((a,b) => a+b, 0) : 0;
    // Legacy positive counters establish hits. A normalized zero without raw
    // telemetry does not establish a miss; never invent historical precision.
    const reported = usage?.cacheReadReported === true || (usage?.cacheReadReported !== false && usage?.cacheRead > 0);
    if (reported && Number.isFinite(total) && total > 0) { rate = 100 * usage.cacheRead / total; previous = false; }
    else previous = true;
  }
  return rate === undefined ? 'CH?' : `CH${rate.toFixed(1)}%${previous ? ' last' : ''}`;
})(this.session.sessionManager.getBranch(), this.session.state.model)); /* PI_CACHE_HIT_FOOTER_V1 */
        // Kimi Coding is subscription-backed despite using API-key authentication.
        const usingSubscription = state.model
            ? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingSubscription(state.model.provider)
            : false;
        statsParts.push((function formatSessionCost(entries, subscription) {
// @ts-nocheck -- Also embedded verbatim in the installed SDK/CLI footer.
/** Compact accounting facts; no prompt, endpoint, credential or response text. */
function readCostEvidence(usage, provider) {
  const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const details = usage?.costDetails;
  if (details && valid(details.reported) && valid(details.estimated) &&
      ['unknown', 'subscription', 'seen'].every(k => typeof details[k] === 'boolean')) {
    return {reported:details.reported, estimated:details.estimated, unknown:details.unknown, subscription:details.subscription, seen:details.seen, estimatedUsage:details.estimatedUsage === true || details.estimated > 0};
  }
  const cost = usage?.cost;
  if (provider === 'openai-codex' || cost?.billing === 'subscription')
    return {reported:0, estimated:0, unknown:false, subscription:true, seen:false, estimatedUsage:false};
  const n = typeof cost === 'number' ? cost : cost?.total;
  const reported = cost?.source === 'provider-reported';
  const provided = reported || cost?.source === 'provider-estimate';
  const tokens = ['input','output','cacheRead','cacheWrite'].some(k => valid(usage?.[k]) && usage[k] > 0);
  const noActivity = usage && ['input','output','cacheRead','cacheWrite','turns'].every(k => usage[k] === 0);
  const seen = valid(n) && (n > 0 || provided || noActivity || tokens && cost?.complete === true);
  return {
    reported:seen && reported ? n : 0,
    estimated:seen && !reported ? n : 0,
    unknown:!seen || !reported && cost?.complete === false || Boolean(details),
    subscription:false,
    seen,
    estimatedUsage:seen && !reported && !noActivity,
  };
}

function mergeCostEvidence(left, right) {
  return {reported:left.reported + right.reported, estimated:left.estimated + right.estimated,
    unknown:left.unknown || right.unknown, subscription:left.subscription || right.subscription, seen:left.seen || right.seen, estimatedUsage:Boolean(left.estimatedUsage || right.estimatedUsage || left.estimated > 0 || right.estimated > 0)};
}

// @ts-nocheck -- Pure collector, embedded in SDK/CLI; imports supplied by patch.

function collectSessionCost(entries, subscription = false) {
  const empty = () => ({reported:0, estimated:0, unknown:false, subscription:false, seen:false});
  const valid = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  const rows = new Map(), nodes = new Map(), aliases = new Map();
  const pending = new Set(), settled = new Set(), seenEntries = new Set();
  let main = empty(), children = empty(), auxiliary = empty(), truncated = false;
  const addRow = (scope, route, evidence) => {
    const key = `${scope}:${route}`;
    const previous = rows.get(key) ?? {scope, route, ...empty()};
    rows.set(key, {...previous, ...mergeCostEvidence(previous,evidence)});
  };
  const idOf = (node, fallback) => {
    const id = typeof node?.runId === 'string' ? `${node.runId}:0` : typeof node?.id === 'string' ? `${node.id}:0` : fallback;
    const file = typeof node?.sessionFile === 'string' ? `file:${node.sessionFile}` : undefined;
    const key = aliases.get(id) ?? (file && aliases.get(file)) ?? id;
    aliases.set(id,key);
    if (file) aliases.set(file,key);
    return key;
  };
  const recordNode = (node, fallback, depth = 0) => {
    if (!node || typeof node !== 'object') { truncated = true; return undefined; }
    if (depth >= 16) { truncated = true; return undefined; }
    const key = idOf(node,fallback);
    const nested = new Set();
    const visit = (list, prefix) => {
      if (!Array.isArray(list)) return;
      list.forEach((child,i) => { const id = recordNode(child,`${key}/${prefix}:${i}`,depth+1); if (id) nested.add(id); });
    };
    visit(node.children,'child');
    for (const [i,step] of (Array.isArray(node.steps) ? node.steps : []).entries()) visit(step?.children,`step:${i}`);
    const inclusive = valid(node.totalCost?.costUsd) ? node.totalCost.costUsd : undefined;
    const own = node.usage ? readCostEvidence(node.usage, node.provider ?? node.usage.cost?.provider) : undefined;
    const totalEvidence = node.totalCost?.costDetails ? readCostEvidence({costDetails:node.totalCost.costDetails}) : undefined;
    const value = inclusive ?? (own?.seen ? own.reported + own.estimated : undefined);
    const next = {key, own, inclusive, totalEvidence, nested, value, turns:node.usage?.turns, routes:node.usage?.costByModel,
      route:node.model ?? node.usage?.cost?.model ?? 'unattributed child', incomplete:node.accountingIncomplete === true};
    const old = nodes.get(key);
    const correction = own && old?.own && next.turns > 0 && next.turns === old.turns &&
      own.seen && own.estimated === 0 && !own.estimatedUsage && old.own.estimatedUsage && !own.unknown;
    const staleEstimate = own?.estimatedUsage && old?.own?.seen && !old.own.estimatedUsage && !old.own.unknown && next.turns > 0 && next.turns === old.turns;
    const quality = e => (e?.unknown ? 0 : 1) + (e?.seen && !e.estimatedUsage ? 2 : 0);
    if (!old || !staleEstimate && (correction || valid(value) && (!valid(old.value) || value > old.value || value === old.value && quality(own) >= quality(old.own)))) {
      next.routes ??= old?.routes;
      if (old) for (const child of old.nested) next.nested.add(child);
      nodes.set(key,next);
    } else for (const child of nested) old.nested.add(child);
    return key;
  };
  const record = (data, terminal) => {
    if (!data || typeof data !== 'object') return;
    const root = data.runId ?? data.asyncId ?? data.id;
    if (typeof root !== 'string') return;
    if (terminal) { pending.delete(root); settled.add(root); }
    else if (!settled.has(root)) pending.add(root);
    if (!Array.isArray(data.results)) return;
    data.results.forEach((node,i) => recordNode(node,`${root}:${node?.index ?? i}`));
  };
  for (const entry of entries) {
    const m = entry.type === 'message' ? entry.message : undefined;
    if (m?.role === 'toolResult' && m.toolName === 'subagent') record(m.details, !m.details?.asyncId && Array.isArray(m.details?.results) && m.details.results.length > 0);
    if (entry.type === 'custom' && entry.customType === 'subagent-cost-v1') record(entry.data,true);
    if (entry.type === 'custom' && entry.customType === 'subagent-lifecycle-v1') {
      const data = entry.data;
      // Terminal lifecycle without cost remains pending until accounting arrives.
      if (typeof data?.runId === 'string' && !settled.has(data.runId) && data.results?.some(r=>r.status !== 'queued')) pending.add(data.runId);
    }
    // Jev judgments bill input-only through OpenRouter; cost is estimated
    // from measured payload characters like any other estimated route.
    if (entry.type === 'custom' && entry.customType === 'jev-usage-v1') {
      const data = entry.data;
      const cost = typeof data?.costUsd === 'number' && data.costUsd >= 0 ? data.costUsd : 0;
      const evidence = {reported:0, estimated:cost, unknown:false, subscription:false, seen:true, estimatedUsage:data?.cached !== true};
      auxiliary = mergeCostEvidence(auxiliary, evidence);
      addRow('auxiliary', typeof data?.model === 'string' && data.model ? `openrouter/${data.model.slice(0,128)}` : 'openrouter/jev', evidence);
    }
    const isMain = m?.role === 'assistant';
    const isAuxiliary = m?.role === 'toolResult' && !['subagent','bg_wait'].includes(m.toolName) && m.usage || ['compaction','branch_summary'].includes(entry.type);
    if (!isMain && !isAuxiliary) continue;
    const id = m?.responseId ? `response:${m.provider}:${m.responseId}` : entry.id ? `entry:${entry.id}` : undefined;
    if (id && seenEntries.has(id)) continue;
    if (id) seenEntries.add(id);
    const usage = m ? m.usage : entry.usage;
    const evidence = readCostEvidence(usage, m?.provider ?? usage?.cost?.provider);
    if (isMain) main = mergeCostEvidence(main,evidence);
    else auxiliary = mergeCostEvidence(auxiliary,evidence);
    const provider = m?.provider ?? usage?.cost?.provider;
    const model = m?.model ?? usage?.cost?.model;
    addRow(isMain ? 'main' : 'auxiliary', provider && model ? `${provider}/${model}` : 'unattributed usage', evidence);
  }
  // Resolve inclusive tree snapshots into own charges. A shared descendant can
  // appear in both a workflow and a step; it is charged once for the session.
  const totals = new Map();
  const totalFor = (key, visiting = new Set()) => {
    if (totals.has(key)) return totals.get(key);
    if (visiting.has(key)) { truncated = true; return 0; }
    const node = nodes.get(key);
    if (!node) return 0;
    visiting.add(key);
    const nested = [...node.nested].reduce((sum,id)=>sum+totalFor(id,visiting),0);
    visiting.delete(key);
    const own = node.own?.seen ? node.own.reported + node.own.estimated : 0;
    const total = Math.max(node.inclusive ?? 0, own + nested);
    totals.set(key,total);
    return total;
  };
  for (const node of nodes.values()) {
    const nested = [...node.nested].reduce((sum,id)=>sum+totalFor(id),0);
    const total = totalFor(node.key);
    const ownTotal = Math.max(0,total - nested);
    let evidence = node.own ?? (node.totalEvidence ? {...node.totalEvidence} :
      readCostEvidence({cost:ownTotal > 0 ? ownTotal : node.inclusive}));
    if (!node.own && nested > 0) {
      // Inclusive provenance cannot establish each descendant's share.
      evidence = {reported:0,estimated:ownTotal,unknown:node.incomplete,subscription:evidence.subscription,seen:ownTotal > 0};
    } else if (ownTotal > evidence.reported + evidence.estimated) {
      evidence = {...evidence, estimated:evidence.estimated + ownTotal - evidence.reported - evidence.estimated, seen:true};
    }
    if (!node.own && node.inclusive === undefined && node.nested.size > 0) evidence = empty();
    evidence.unknown ||= node.incomplete;
    children = mergeCostEvidence(children,evidence);
    const routes = Array.isArray(node.routes) ? node.routes.filter(r=>typeof r?.route === 'string' && r.route.length <= 512).map(r=>({route:r.route,evidence:readCostEvidence({costDetails:r.evidence})})) : [];
    const routeTotal = routes.reduce((sum,r)=>sum+r.evidence.reported+r.evidence.estimated,0);
    if (routes.length && Math.abs(routeTotal - evidence.reported - evidence.estimated) < 1e-10)
      for (const r of routes) addRow('children',r.route,r.evidence);
    else addRow('children',node.route,evidence);
  }
  const evidence = mergeCostEvidence(mergeCostEvidence(main,auxiliary),children);
  // Current selection alone is not proof that this session used a subscription.
  evidence.subscription ||= subscription && !evidence.seen;
  evidence.unknown ||= pending.size > 0 || truncated;
  const total = evidence.reported + evidence.estimated;
  const amount = total > 0 && total < 0.000001 ? total.toExponential(3) : total > 0 && total < 1 ? total.toFixed(6) : total.toFixed(3);
  const formatted = evidence.seen ? `$${evidence.estimatedUsage ? '~' : ''}${amount}${evidence.unknown ? '+?' : ''}${evidence.subscription ? ' (sub)' : ''}` : evidence.subscription ? `sub${evidence.unknown ? '+?' : ''}` : '$?';
  return {total, ...evidence, main, children, auxiliary, pending:pending.size, rows:[...rows.values()], formatted};
}

return collectSessionCost(entries,subscription).formatted;
})(this.session.sessionManager.getEntries(), usingSubscription) + " total"); /* PI_FOOTER_ACCURACY_V2 */
        // Colorize context percentage based on usage
        let contextPercentStr;
        const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
        const contextPercentDisplay = contextPercent === "?"
            ? `?/${formatTokens(contextWindow)}${autoIndicator}`
            : `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
        if (contextPercentValue > 90) {
            contextPercentStr = theme.fg("error", contextPercentDisplay);
        }
        else if (contextPercentValue > 70) {
            contextPercentStr = theme.fg("warning", contextPercentDisplay);
        }
        else {
            contextPercentStr = contextPercentDisplay;
        }
        statsParts.push(contextPercentStr);
        if (areExperimentalFeaturesEnabled()) {
            statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
        }
        let statsLeft = statsParts.sort((a,b)=>(a===contextPercentStr?0:a.startsWith("CH")?1:a.startsWith("$")||a==="sub"?2:3)-(b===contextPercentStr?0:b.startsWith("CH")?1:b.startsWith("$")||b==="sub"?2:3)).join(" ");
        // Add model name on the right side, plus thinking level if model supports it
        const modelName = state.model?.id || "no-model";
        let statsLeftWidth = visibleWidth(statsLeft);
        // If statsLeft is too wide, truncate it
        if (statsLeftWidth > width) {
            statsLeft = truncateToWidth(statsLeft, width, "...");
            statsLeftWidth = visibleWidth(statsLeft);
        }
        // Calculate available space for padding (minimum 2 spaces between stats and model)
        const minPadding = 2;
        // Add thinking level indicator if model supports reasoning
        let rightSideWithoutProvider = modelName;
        if (state.model?.reasoning) {
            const thinkingLevel = state.thinkingLevel || "off";
            rightSideWithoutProvider =
                thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
        }
        // Prepend the provider in parentheses if there are multiple providers and there's enough room
        let rightSide = rightSideWithoutProvider;
        try { const sid = String(this.session.sessionManager.getSessionId()); if (sid && sid !== "undefined") rightSide += ` · ${sid.slice(0, 8)}`; } catch {}
        if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
            rightSide = `(${state.model.provider}) ${rightSideWithoutProvider}`;
            if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
                // Too wide, fall back
                rightSide = rightSideWithoutProvider;
            }
        }
        const rightSideWidth = visibleWidth(rightSide);
        const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;
        let statsLine;
        if (totalNeeded <= width) {
            // Both fit - add padding to right-align model
            const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
            statsLine = statsLeft + padding + rightSide;
        }
        else {
            // Need to truncate right side
            const availableForRight = width - statsLeftWidth - minPadding;
            if (availableForRight > 0) {
                const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
                const truncatedRightWidth = visibleWidth(truncatedRight);
                const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
                statsLine = statsLeft + padding + truncatedRight;
            }
            else {
                // Not enough space for right side at all
                statsLine = statsLeft;
            }
        }
        // Apply dim to each part separately. statsLeft may contain color codes (for context %)
        // that end with a reset, which would clear an outer dim wrapper. So we dim the parts
        // before and after the colored section independently.
        const dimStatsLeft = theme.fg("dim", statsLeft);
        const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
        const dimRemainder = theme.fg("dim", remainder);
        const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
        const lines = [pwdLine, dimStatsLeft + dimRemainder];
        // Add extension statuses on a single line, sorted by key alphabetically
        const activityMetrics = (/** Pure, transcript-backed accounting. Embedded verbatim in both footer builds.
 * Cumulative snapshots are replaced by segment ID, never added twice. */
function collectSessionMetrics(entries, live) {
 const m={responses:0,toolCalls:0,toolResults:0,errors:0,modelErrors:0,blocked:0,compactions:0,agents:0,agentFailures:0,agentsActive:0,agentsCompleted:0,agentsStopped:0,agentsPaused:0,agentOutcomeUnknown:0,workflows:0,workflowFailures:0,workflowsActive:0,workflowOutcomeUnknown:0,swarms:0,fusions:0,legacySwarms:0,legacyFusions:0,recoveries:0,tools:{},skillsRead:[],skillsPartial:[],skillsRouted:[],input:0,output:0,cacheRead:0,cacheWrite:0,reasoning:0,childTokens:0,childRows:0,childRowsWithUsage:0,hooks:{},hookCalls:0,hookExcluded:0,hookChanged:0,hookErrors:0,trimmedChars:0,addedChars:0,telemetry:false,rawReturnedChars:0,uncachedInput:0,cachedReuse:0,noCacheTurns:0,noCacheInput:0,invalidationTurns:0,invalidationExcessTokens:0,abortedTelemetry:0,assistantTurns:0,perModel:{},jev:{hits:0,cached:0,tokens:0,costUsd:0,bySite:{}}};
 const calls=new Set(), results=new Set(), agents=new Map(), workflows=new Map(), segments=new Map(), activities=new Map(), read=new Set(), partial=new Set(), routed=new Set(), callInputs=new Map(), aliases=new Map(), groups=[],nativeGroups=new Set(),legacyFusions=[];
 const number=v=>Number.isFinite(v)&&v>=0?v:0;
 const name=p=>String(p).replace(/\\/g,'/').split('/').filter(Boolean).slice(-2,-1)[0]||String(p);
 const text=c=>typeof c==='string'?c:Array.isArray(c)?c.filter(p=>p?.type==='text').map(p=>p.text).join('\n'):'';
 const usage=u=>{if(u)for(const k of ['input','output','cacheRead','cacheWrite','reasoning'])m[k]+=number(u[k]);};
 // Per-route usage keys off the assistant message's own provider/model (usage
 // objects do not carry a route). Compaction/summary usage names no route and
 // stays explicitly unattributed — never guessed from neighbors.
 const rowFor=route=>{
  if(typeof route!=='string'||!route)return undefined;
  if(!m.perModel[route]){
   if(Object.keys(m.perModel).length>=256)return undefined;
   m.perModel[route]={turns:0,input:0,cacheRead:0,cacheWrite:0,output:0,reasoning:0,errors:0,thinking:[],routing:[],endpoints:[]};
  }
  return m.perModel[route];
 };
 const routeOf=(msg,u)=>{
  if(u&&typeof u.route==='string'&&u.route.trim())return u.route.trim().slice(0,160);
  const p=msg?.provider,id=msg?.model;
  if(typeof p==='string'&&p.trim()&&typeof id==='string'&&id.trim())return `${p.trim()}/${id.trim()}`.slice(0,160);
  return null;
 };
 const noteModel=(route,u,isError)=>{
  const r=rowFor(route);
  if(!r||!u||typeof u!=='object')return;
  r.turns++;if(isError)r.errors++;
  for(const k of ['input','cacheRead','cacheWrite','output','reasoning'])r[k]+=number(u[k]);
 };
 const pinText=value=>{
  if(!value||typeof value!=='object'||Array.isArray(value))return '';
  try{const text=JSON.stringify(value);return text.length>256?'':text;}catch{return '';}
 };
 // Turn-level cache accounting needs new-content context: characters appended
 // since the previous assistant message plus that message's output. This
 // mirrors scripts/lib/token-cost-diagnostics.mjs at transcript scale: it is
 // a magnitude check, not a tokenizer, and separates uncached input,
 // cached reuse, no-cache routes and prefix-invalidation excess explicitly.
 let pendingChars=0, prevOutput=0;
 const visibleChars=c=>typeof c==='string'?c.length:Array.isArray(c)?c.filter(p=>p?.type==='text'&&typeof p.text==='string').reduce((s,p)=>s+p.text.length,0)+c.filter(p=>p?.type==='toolCall').reduce((s,p)=>s+String(p.name??'').length,0):0;
 const noteAssistant=(u,msg,isError=false,unattributed=false)=>{
  if(!u||typeof u!=='object')return;
  const input=number(u.input),cacheRead=number(u.cacheRead),cacheWrite=number(u.cacheWrite),output=number(u.output);
  const prompt=input+cacheRead+cacheWrite;
  m.assistantTurns++;
  m.uncachedInput+=input;m.cachedReuse+=cacheRead;
  noteModel(unattributed?'(unattributed compaction/summary)':routeOf(msg,u),u,isError);
  if(cacheRead===0&&cacheWrite===0&&prompt>=3000){m.noCacheTurns++;m.noCacheInput+=input;}
  const newContent=Math.round(pendingChars/4)+prevOutput;
  const excess=input-newContent;
  if(cacheRead>0&&excess>=3000){m.invalidationTurns++;m.invalidationExcessTokens+=excess;}
  pendingChars=0;prevOutput=output+number(u.reasoning);
 };
 const terminal=new Set(['completed','failed','stopped']);
 const hookNames=new Set(['input','before_agent_start','context','before_provider_request','tool_call','tool_result','session_before_switch','session_before_fork','session_before_compact','session_before_tree']);
 const normalizedState=v=>v==='complete'?'completed':v==='rejected'?'failed':['queued','running','completed','failed','stopped','paused','detached'].includes(v)?v:'unknown';
 // Older automatic-helper ledgers used a wrapper ID and omitted the native
 // ID. Repair only exact run-0 session paths naming an observed single run;
 // never infer identity from model, timing, status, or a neighboring entry.
 const nativeSingles=new Set(entries.filter(e=>e.type==='custom'&&e.customType==='subagent-lifecycle-v1'&&e.data?.mode==='single').map(e=>e.data.runId));
 const helperRuns=new Map();
 for(const e of entries){
  const d=e.type==='custom'&&e.customType==='subagent-cost-v1'?e.data:undefined;
  if(!d||!/^(?:auto-assist|quality-review|skill-discovery|scope-council)-/.test(d.runId)||d.results?.length!==1)continue;
  const r=d.results[0];
  if(!r||r.runId||(r.index??0)!==0||typeof r.sessionFile!=='string'||r.sessionFile.length>4096||r.sessionFile.split('/').some(p=>p==='.'||p==='..'))continue;
  const id=r.sessionFile.match(/^\/.*\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/run-0\/session\.jsonl$/)?.[1];
  if(id&&nativeSingles.has(id))helperRuns.set(d.runId,helperRuns.has(d.runId)&&helperRuns.get(d.runId)!==id?null:id);
 }
 const record=(d,fallback,accounted=false)=>{
  if(!d||typeof d!=='object')return;
  const root=d.runId||d.asyncId||d.id||fallback;
  if(!root)return;
  if(d.mode==='workflow'||workflows.has(root)){
   const old=workflows.get(root);let status=normalizedState(d.state??d.workflowChildren?.workflowState??(d.success===true?'completed':d.success===false?'failed':undefined));
   if(status==='unknown')status=accounted?'finished-unknown':d.asyncId?'queued':old??'unknown';
   if(terminal.has(old)&&!terminal.has(status))status=old;
   workflows.set(root,status);
  }
  if(d.events){const previous=activities.get(root)??{};activities.set(root,Object.fromEntries(['swarms','fusions','recoveries'].map(k=>[k,Math.max(number(previous[k]),number(d.events[k]))])));}
  const workflow=Array.isArray(d.workflowChildren?.children)?d.workflowChildren.children:undefined;
  let rows=workflow??(Array.isArray(d.results)?d.results:[]);
  // A detached single launch has no completed results yet. Count its accepted
  // child immediately; never count a workflow controller as a child.
  if(!rows.length&&d.mode==='single'&&d.asyncId)rows=[{index:0,status:d.state??'queued'}];
  if(d.mode==='parallel'&&rows.filter(r=>!['pending'].includes(r?.status??r?.state)&&((r?.status??r?.state)&&normalizedState(r.status??r.state)!=='unknown'||r?.runId||r?.exitCode!==undefined||r?.usage)).length>1)nativeGroups.add(root);
  for(const group of d.mode==='parallel'?[]:d.parallelGroups??[])if(group.count>1&&rows.filter((r,i)=>(r?.index??i)>=group.start&&(r?.index??i)<group.start+group.count&&!['pending','unknown'].includes(r?.status??r?.state??'unknown')).length>1)nativeGroups.add(`${root}:group:${group.start}`);
  for(const [i,r] of rows.entries()) {
   if(!r||typeof r!=='object'||r.status==='pending'||r.state==='pending')continue;
   const ids=[`${root}:${r.workflowKey??r.childId??r.index??i}`];
   const nativeId=r.runId??(rows.length===1&&(r.index??i)===0?helperRuns.get(root):undefined);
   if(nativeId)ids.push(`${nativeId}:0`);
   const keys=[...new Set(ids.map(id=>aliases.get(id)??id))];
   const key=keys.find(k=>agents.has(k))??keys[0];
   let old=agents.get(key)||{};
   for(const duplicate of keys)if(duplicate!==key&&agents.has(duplicate)){
    const other=agents.get(duplicate);old={...other,...old,status:terminal.has(old.status)?old.status:terminal.has(other.status)?other.status:old.status??other.status,tokens:Math.max(old.tokens||0,other.tokens||0)};agents.delete(duplicate);
    for(const [alias,target] of aliases)if(target===duplicate)aliases.set(alias,key);
   }
   for(const id of ids)aliases.set(id,key);
   const tokens=['input','output','cacheRead','cacheWrite'].reduce((s,k)=>s+number(r.usage?.[k]),0);
   // Coverage of child accounting: many ledger rows are non-terminal
   // placeholders without usage (measured 81 of 166 rows on 2026-09-14), so a
   // bare total would read as "zero child traffic" when it is really "no usage
   // recorded yet for these rows".
   m.childRows++;if(r.usage)m.childRowsWithUsage++;
   let status=normalizedState(r.status??r.state);
   if(r.stopped||status==='stopped')status='stopped';
   else if(r.interrupted||status==='paused')status='paused';
   else if(r.detached||status==='detached')status='detached';
   else if(r.error||r.timedOut||r.exitCode!==undefined&&r.exitCode!==0)status='failed';
   else if(r.exitCode===0)status='completed';
   // Late start receipts/accounting without an outcome cannot resurrect a
   // completed child. Unknown old metadata remains visibly unknown.
   if(status==='unknown'&&(r.usage||r.sessionFile)&&['queued','running','detached'].includes(old.status))status='finished-unknown';
   else if(status==='unknown'||terminal.has(old.status)&&!terminal.has(status))status=old.status??status;
   agents.set(key,{tokens:Math.max(old.tokens||0,tokens),status});
  }
 };

 for(const [i,e] of entries.entries()) {
  const msg=e.type==='message'?e.message:undefined;
  if(e.type==='custom'&&e.customType==='jev-usage-v1'){
   const d=e.data??{};
   m.jev.hits++;if(d.cached===true)m.jev.cached++;m.jev.tokens+=number(d.inputTokens);
   if(typeof d.costUsd==='number'&&d.costUsd>=0)m.jev.costUsd+=d.costUsd;
   const site=typeof d.site==='string'&&d.site?d.site.slice(0,48):'unknown';
   if(!m.jev.bySite[site]&&Object.keys(m.jev.bySite).length<64)m.jev.bySite[site]={hits:0,tokens:0,costUsd:0};
   const row=m.jev.bySite[site];if(row){row.hits++;row.tokens+=number(d.inputTokens);if(typeof d.costUsd==='number'&&d.costUsd>=0)row.costUsd+=d.costUsd;}
  }
  if(msg?.role==='assistant') {
   m.responses++;usage(msg.usage);noteAssistant(msg.usage,msg,msg.stopReason==='error');if(msg.stopReason==='error')m.modelErrors++;
   // Aborted/zero-content attempts are telemetry, never model-visible
   // evidence: counted here so the footer can report them without
   // projecting their empty body back into context.
   if((msg.stopReason==='aborted'||msg.stopReason==='error')&&visibleChars(msg.content)===0&&!String(msg.errorMessage??''))m.abortedTelemetry++;
   else if(visibleChars(msg.content)===0&&(msg.content??[]).length===0&&number(msg.usage?.input)===0&&number(msg.usage?.output)===0)m.abortedTelemetry++;
   for(const c of msg.content??[])if(c.type==='toolCall'&&!calls.has(c.id??`call:${i}`)){calls.add(c.id??`call:${i}`);m.toolCalls++;callInputs.set(c.id,{name:c.name,input:c.arguments??{}});}
  }
  if(msg?.role==='toolResult'&&!results.has(msg.toolCallId??`result:${i}`)) {
   results.add(msg.toolCallId??`result:${i}`);m.toolResults++;m.tools[msg.toolName]=(m.tools[msg.toolName]||0)+1;m.rawReturnedChars+=visibleChars(msg.content);pendingChars+=visibleChars(msg.content);
   if(msg.isError || msg.toolName==='web_search' && msg.details?.queryCount>0 && msg.details?.successfulQueries===0){m.errors++;if(/^Blocked:/.test(text(msg.content)))m.blocked++;}
   // Status/list/inspection can legally view another session's runs. Only
   // execution receipts and owner-scoped lifecycle ledgers contribute agents.
   if(msg.toolName==='subagent'&&!callInputs.get(msg.toolCallId)?.input?.action)record(msg.details,msg.toolCallId);
   const call=callInputs.get(msg.toolCallId),input=call?.input??{};
   const path=input.path??input.file_path;
   if(!msg.isError&&call?.name==='read'&&typeof path==='string'&&/(?:^|[\\/])SKILL\.md$/i.test(path)){
    const full=(input.offset===undefined||input.offset===1)&&input.limit===undefined&&msg.details?.truncation?.truncated!==true;
    (full?read:partial).add(name(path));
   }
  }
  if(msg?.role==='user')pendingChars+=visibleChars(msg.content);
  if(e.type==='compaction'){m.compactions++;usage(e.usage);noteAssistant(e.usage,undefined,false,true);pendingChars=0;}
  if(e.type==='branch_summary'){usage(e.usage);noteAssistant(e.usage,undefined,false,true);}
  if(e.type==='custom'&&['subagent-cost-v1','subagent-lifecycle-v1'].includes(e.customType))record(e.data,e.id,e.customType==='subagent-cost-v1');
  if(e.type==='custom'&&e.customType==='relevant-guidance'){
   for(const p of e.data?.read??[])read.add(name(p));
   for(const p of e.data?.shown??[])if(p.startsWith('skill:')||p.startsWith('skillctx:'))routed.add(name(p));
  }
  if(e.type==='custom'&&e.customType==='provider-recovery'&&/^Automatic free read-only group:/.test(e.data?.text??''))groups.push({id:e.id??`legacy:${i}`,time:Date.parse(e.timestamp)||0});

  if(e.type==='custom_message'&&e.customType==='autonomous-free-fusion')legacyFusions.push({id:e.id??`fusion:${i}`,time:Date.parse(e.timestamp)||0});
  if(e.type==='custom'&&e.customType==='session-metrics-v1'&&typeof e.data?.segment==='string')segments.set(e.data.segment,e.data);
  // Selection-boundary records pair each used route with the thinking level
  // and OpenRouter backend routing it ran with. Thinking/routing for routes
  // without a record stays empty — never reconstructed by guessing.
  if(e.type==='custom'&&e.customType==='model-config-v1'&&e.data&&typeof e.data==='object'){
   const route=typeof e.data.route==='string'&&e.data.route.trim()?e.data.route.trim().slice(0,160):null;
   const r=rowFor(route);
   if(r){
    if(typeof e.data.thinking==='string'&&e.data.thinking.trim()){
     const level=e.data.thinking.trim().slice(0,16);
     if(!r.thinking.includes(level))r.thinking.push(level);
    }
    const pin=pinText(e.data.openRouterRouting);
    if(pin&&!r.routing.includes(pin))r.routing.push(pin);
    if(typeof e.data.recoveryEndpointName==='string'&&e.data.recoveryEndpointName.trim()){
     const name=e.data.recoveryEndpointName.trim().slice(0,160);
     if(!r.endpoints.includes(name))r.endpoints.push(name);
    }
   }
  }
 }
 if(live?.segment)segments.set(live.segment,live);
 for(const s of segments.values()){
  m.telemetry=true;
  for(const [k,v] of Object.entries(s.hooks??{})){
   const cut=k.lastIndexOf(':'),owner=k.slice(0,cut).split('/').pop(),hook=k.slice(cut+1);
   if(!hookNames.has(hook)||['health-log.ts','session-telemetry.ts'].includes(owner)){m.hookExcluded+=number(v.calls);continue;}
   const h=m.hooks[k]??={calls:0,errors:0,ms:0,changed:0,removedChars:0,addedChars:0,charsChanged:0,tokensChanged:0};
   for(const key of ['calls','errors','ms','changed','removedChars','addedChars','charsChanged','tokensChanged'])h[key]+=number(v[key]);
   for(const key of ['beforeHash','afterHash','semanticHash'])if(h[key]===undefined&&typeof v[key]==='string'&&/^[0-9a-f]{8}$/.test(v[key]))h[key]=v[key];
   if(Number.isSafeInteger(v.changedAt)&&v.changedAt>=0&&v.changedAt<=20000&&(h.changedAt===undefined||v.changedAt<h.changedAt))h.changedAt=v.changedAt;
   if(Number.isSafeInteger(v.revision)&&v.revision>=0)h.revision=v.revision;
   if(Number.isFinite(v.cacheAgeMs)&&v.cacheAgeMs>=0)h.cacheAgeMs=Math.max(h.cacheAgeMs??0,v.cacheAgeMs);
  }
  for(const k of ['swarms','fusions','recoveries'])m[s.version===2||k==='recoveries'?k:k==='swarms'?'legacySwarms':'legacyFusions']+=number(s.events?.[k]);
  m.abortedTelemetry+=number(s.events?.aborted);
 }
 // Legacy auto-groups are only inferred when no corresponding new event exists.
 const measuredSince=Math.min(...[...segments.values()].map(s=>Number.isFinite(s.startedAt)?s.startedAt:Infinity));
 m.legacySwarms+=new Set(groups.filter(g=>g.time<measuredSince).map(g=>g.id)).size;m.swarms+=nativeGroups.size;
 for(const a of activities.values())for(const k of ['swarms','fusions','recoveries'])m[k]+=number(a[k]);
 m.legacyFusions+=new Set(legacyFusions.filter(g=>g.time<measuredSince).map(g=>g.id)).size;
 for(const h of Object.values(m.hooks)){m.hookCalls+=h.calls;m.hookChanged+=h.changed;m.hookErrors+=h.errors;m.trimmedChars+=h.removedChars;m.addedChars+=h.addedChars;}
 for(const a of agents.values()){m.agents++;m.childTokens+=a.tokens;if(a.status==='failed')m.agentFailures++;else if(a.status==='completed')m.agentsCompleted++;else if(a.status==='stopped')m.agentsStopped++;else if(a.status==='paused')m.agentsPaused++;else if(['queued','running','detached'].includes(a.status))m.agentsActive++;else m.agentOutcomeUnknown++;}
 // Diagnostics consume the same identity resolution and final outcomes.
 m.agentAliases=Object.fromEntries(aliases);
 m.agentStates=Object.fromEntries([...agents].map(([key,a])=>[key,a.status]));
 for(const status of workflows.values()){m.workflows++;if(status==='failed')m.workflowFailures++;else if(['queued','running','detached'].includes(status))m.workflowsActive++;else if(['unknown','finished-unknown'].includes(status))m.workflowOutcomeUnknown++;}
 m.skillsRead=[...read].sort();m.skillsPartial=[...partial].filter(s=>!read.has(s)).sort();m.skillsRouted=[...routed].sort();
 m.distinctTools=Object.keys(m.tools).length;
 const prompt=m.input+m.cacheRead+m.cacheWrite;m.cacheRate=prompt>0?100*m.cacheRead/prompt:null;
 // Unique vs repeated: segment snapshots are cumulative and replaced by
 // segment ID, so trimmedChars is unique context removed per segment, while
 // addedChars is repeated projection churn (bytes re-added on later
 // projections). Repeatedly processed characters are churn, never unique
 // token savings and never billed savings.
 m.uniqueContextRemovedChars=m.trimmedChars;m.projectionChurnChars=m.addedChars;
 m.estimatedBilledSavingsNote='cached-token reuse avoids full-price rebill of the matched prefix; it is not a billed-amount saving and repeated churn must not be counted as savings';
 const parentFailures=m.errors+m.modelErrors, totalFailures=parentFailures+m.agentFailures+m.workflowFailures;
 // Bottom KPI layer: only the powers this session actually used, emoji + count.
 // The full breakdown stays in /metrics (m.detail); ordering is stable by count
 // then name so the footer does not reshuffle between renders.
 const powerLabels = {subagent:'🤖',quality_review:'🔍',project_tests:'🧪',skill_review:'📚',session_self:'🪞',project_report:'🗺️',module_report:'🧭',symbol_search:'🔎',context_slice:'✂️',context_score:'🎯',handoff_capsule:'💊',evidence_cache:'🗃️',bg_run:'⏳',media_info:'🎬',media_edit:'🎞️',video_frames:'🎬',audio_analyze:'🔊',music_compose:'🎵',browser_session:'🌐',agentmail_status:'✉️',agentmail_send:'✉️',agentmail_messages:'📬',agentmail_search:'🔎',agentmail_message:'📨',render_see:'👁️',sandbox_run:'📦',obs_read:'🔬',context_profile:'📈',tool_search:'🧰'};
 const powers=Object.entries(m.tools).filter(([name])=>powerLabels[name]).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,8).map(([name,count])=>`${powerLabels[name]}${count}`);
 const sessionEntry=entries.find(e=>e?.type==='session');
 const shortSessionId=typeof sessionEntry?.id==='string'?sessionEntry.id.slice(0,8):'';
 m.footer=[`Agents ${m.agents} (${m.agentsActive} active)`,totalFailures?`Failures ${totalFailures} (P${parentFailures} C${m.agentFailures} W${m.workflowFailures})`:'Failures 0'];
 if(powers.length)m.footer.push(`Powers ${powers.join(' ')}`);
 if(shortSessionId)m.footer.push(`session ${shortSessionId}`);
 m.detail=[
  'Session activity (all retained entries; includes pre-compaction history)',
  `Verified swarm / parallel-group operations: ${m.swarms}; fusions: ${m.fusions}; legacy records with older definitions: ${m.legacySwarms} swarms, ${m.legacyFusions} fusions (may include reused groups or single-output forwarding); recovery plans: ${m.telemetry?m.recoveries:'unknown before telemetry'}`,
  `Accepted/observed child runs: ${m.agents}; last observed active (queued/running/detached): ${m.agentsActive}; completed: ${m.agentsCompleted}; failed: ${m.agentFailures}; stopped: ${m.agentsStopped}; paused: ${m.agentsPaused}; unknown outcome: ${m.agentOutcomeUnknown}`,
  `Workflow controllers: ${m.workflows}; last observed active: ${m.workflowsActive}; failed: ${m.workflowFailures}; unknown outcome: ${m.workflowOutcomeUnknown}. Controllers are not child agents; a reported controller failure may also be a parent tool error.`,
  `Parent model responses: ${m.responses}; tool calls: ${m.toolCalls}; tool results: ${m.toolResults}; distinct tools observed: ${m.distinctTools}. Breadth is descriptive, not a target or proof of effective use.`,
  `Parent errors: ${m.errors} tool + ${m.modelErrors} model; blocked tools: ${m.blocked}; hook errors: ${m.telemetry?m.hookErrors:'unknown'}`,
  `Compactions: ${m.compactions}; recorded child token traffic: ${m.childTokens.toLocaleString('en-US')} (from ${m.childRowsWithUsage.toLocaleString('en-US')} of ${m.childRows.toLocaleString('en-US')} recorded child row(s) carrying usage)`,
  `Parent + compaction token traffic: input ${m.input.toLocaleString('en-US')}, output ${m.output.toLocaleString('en-US')}, cached reads ${m.cacheRead.toLocaleString('en-US')}, cache writes ${m.cacheWrite.toLocaleString('en-US')}`,
  `Reported reasoning tokens: ${m.reasoning.toLocaleString('en-US')} (a subset of output, not additional traffic)`,
  `Cumulative prompt cache reuse: ${m.cacheRate===null?'unknown':m.cacheRate.toFixed(2)+'%'}; cached tokens were reused, not removed from traffic.`,
  `Cache detail: uncached input ${m.uncachedInput.toLocaleString('en-US')} tokens across ${m.assistantTurns} billed assistant turns; cached reuse ${m.cachedReuse.toLocaleString('en-US')} tokens; no-cache turns ${m.noCacheTurns} (${m.noCacheInput.toLocaleString('en-US')} uncached tokens on routes without caching); invalidation turns ${m.invalidationTurns} with ~${m.invalidationExcessTokens.toLocaleString('en-US')} excess uncached tokens (cached prefix stopped matching and was rebilled). New-content is chars/4 magnitude, not a tokenizer.`,
  `Estimated billed effect: reuse avoids full-price rebill of the matched prefix; it is NOT a billed-amount saving. Repeated projection churn must never be reported as unique savings. Actual billed amounts live in /cost and session-cost evidence, not here.`,
  `Context occupancy vs raw traffic: raw returned characters ${m.rawReturnedChars.toLocaleString('en-US')} in ${m.toolResults} results are pre-projection bytes, not active-context occupancy, tokens, or billed savings. Active occupancy is the live window (see session_self context); unique context removed is below.`,
  m.telemetry?`Unique context removed: ${m.uniqueContextRemovedChars.toLocaleString('en-US')} characters (~${Math.round(m.uniqueContextRemovedChars/4).toLocaleString('en-US')} tokens at 4 chars/token), deduplicated by telemetry segment; repeated projection churn re-added: ${m.projectionChurnChars.toLocaleString('en-US')} chars. Churn is reprocessing cost, not savings.`:'Historical harness token savings: unknown; context payload reductions were not recorded.',
  m.abortedTelemetry?`Aborted/zero-content assistant attempts kept as telemetry (not model-visible): ${m.abortedTelemetry}.`:'Aborted/zero-content assistant attempts: none counted; empty aborted attempts stay telemetry, never projected context.',
  `Parent skills suggested: ${m.skillsRouted.join(', ')||'none recorded'}`,
  `Parent skills fully read: ${m.skillsRead.join(', ')||'none recorded'}; partial reads only: ${m.skillsPartial.join(', ')||'none'}. A routed suggestion is not a read or proof of application.`,
  'Tools: '+Object.entries(m.tools).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k} ${v}`).join(', '),
  m.telemetry?`Hook checks: ${m.hookCalls} intervention-handler calls; ${m.hookChanged} returned results (not proof of useful changes). Excluded ${m.hookExcluded} streaming/lifecycle-observer notifications from legacy telemetry.`:'Extension hook invocations before instrumentation: unknown. Health logs contain lifecycle events only.',
  ...Object.entries(m.hooks).sort((a,b)=>b[1].calls-a[1].calls).map(([k,v])=>`${k}: ${v.calls} calls, ${v.errors} errors, ${Math.round(v.ms)} ms, ${v.changed} returned results`),
 ];
 // Ordered route table for /metrics and export. perModel stays the keyed form.
 m.modelsUsed=Object.entries(m.perModel).map(([route,r])=>({route,...r})).sort((a,b)=>b.input-a.input||b.turns-a.turns);
 return m;
})(this.session.sessionManager.getEntries(), globalThis[Symbol.for('yunus-pi.metrics-view.v1')]?.(this.session.sessionManager.getSessionId?.()));
let activityLine = '';
for (const part of activityMetrics.footer) {
  const next = activityLine ? activityLine + ' · ' + part : part;
  if (activityLine && visibleWidth(next) > width) { lines.push(theme.fg('dim', truncateToWidth(activityLine, width))); activityLine = part; }
  else activityLine = next;
}
if (activityLine) lines.push(theme.fg('dim', truncateToWidth(activityLine, width)));
/* PI_SESSION_ACTIVITY_V2 */ const extensionStatuses = this.footerData.getExtensionStatuses();
        if (extensionStatuses.size > 0) {
            const sortedStatuses = Array.from(extensionStatuses.entries())
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([, text]) => sanitizeStatusText(text));
            const statusLine = sortedStatuses.join(" ");
            // Truncate to terminal width with dim ellipsis for consistency with footer style
            lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
        }
        return lines;
    }
}
