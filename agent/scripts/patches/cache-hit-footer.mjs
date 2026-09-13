// Update-safe SDK + CLI footer fix. Unknown usage is not a zero cache hit.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

// Literal payload, deliberately NOT Function.toString(): formatting this patch
// must not change its emitted bytes and invalidate a previously applied target.
const legacyCacheHitSource =
  "function formatCacheHit(entries, model) {\n  let rate, previous = false;\n  for (const entry of entries) {\n    // Never attribute a previous route's cache to a newly selected provider.\n    if (entry.type === 'model_change') {\n      rate = undefined;\n      previous = false;\n      continue;\n    }\n    const message = entry.type === 'message' ? entry.message : undefined;\n    if (message?.role !== 'assistant') continue;\n    if (message.provider !== model?.provider || message.model !== model?.id) {\n      rate = undefined;\n      previous = false;\n      continue;\n    }\n    const usage = message.usage;\n    const counters = [usage?.input, usage?.cacheRead, usage?.cacheWrite];\n    const valid = counters.every(value => Number.isFinite(value) && value >= 0);\n    const total = valid ? counters.reduce((sum, value) => sum + value, 0) : 0;\n    if (Number.isFinite(total) && total > 0) {\n      rate = 100 * usage.cacheRead / total;\n      previous = false;\n    } else {\n      previous = true;\n    }\n  }\n  return rate === undefined ? 'CH?' : `CH${rate.toFixed(1)}%${previous ? ' last' : ''}`;\n}";

export const cacheHitSource = "function formatCacheHit(entries, model) {\n  let rate, previous = false;\n  for (const entry of entries) {\n    if (entry.type === 'model_change') { rate = undefined; previous = false; continue; }\n    const message = entry.type === 'message' ? entry.message : undefined;\n    if (message?.role !== 'assistant') continue;\n    if (message.provider !== model?.provider || message.model !== model?.id) { rate = undefined; previous = false; continue; }\n    const usage = message.usage;\n    const counters = [usage?.input, usage?.cacheRead, usage?.cacheWrite];\n    const valid = counters.every(v => Number.isFinite(v) && v >= 0);\n    const total = valid ? counters.reduce((a,b) => a+b, 0) : 0;\n    // Legacy positive counters establish hits. A normalized zero without raw\n    // telemetry does not establish a miss; never invent historical precision.\n    const reported = usage?.cacheReadReported === true || (usage?.cacheReadReported !== false && usage?.cacheRead > 0);\n    if (reported && Number.isFinite(total) && total > 0) { rate = 100 * usage.cacheRead / total; previous = false; }\n    else previous = true;\n  }\n  return rate === undefined ? 'CH?' : `CH${rate.toFixed(1)}%${previous ? ' last' : ''}`;\n}";
const previousSessionCostSource = "function formatSessionCost(entries, subscription) {\n  let total = 0, estimate = false, unknown = false, seen = false;\n  for (const e of entries) {\n    const m = e.type === 'message' ? e.message : undefined;\n    if (!(m?.role === 'assistant' || m?.role === 'toolResult' && m.usage || ['compaction','branch_summary'].includes(e.type))) continue;\n    const u = m ? m.usage : e.usage;\n    const n = u?.cost?.total;\n    const reported = u?.cost?.source === 'provider-reported';\n    const tokens = [u?.input,u?.output,u?.cacheRead,u?.cacheWrite].some(v => Number.isFinite(v) && v > 0);\n    if (!reported && !tokens) { unknown = true; continue; }\n    if (!Number.isFinite(n) || n < 0 || n === 0 && !reported) { unknown = true; continue; }\n    seen = true; total += n; estimate ||= !reported;\n  }\n  if (!seen) return subscription ? 'sub' : '$?';\n  const value = total > 0 && total < 0.001 ? total.toFixed(6) : total.toFixed(3);\n  return `$${estimate ? '~' : ''}${value}${unknown ? '+?' : ''}${subscription ? ' (sub)' : ''}`;\n}";

const legacySessionCostSource = previousSessionCostSource
  .replace("const reported = u?.cost?.source === 'provider-reported';", "const reported = u?.cost?.source === 'provider-reported';\n    const provided = reported || u?.cost?.source === 'provider-estimate';")
  .replace("if (!reported && !tokens)", "if (!provided && !tokens)")
  .replace("n === 0 && !reported", "n === 0 && !provided")
  .replace("total < 0.001", "total < 1");

const releasedSessionCostSource = "function formatSessionCost(entries, subscription) {\n  let total = 0, estimate = false, unknown = false, seen = false;\n  const children = new Map(), pending = new Set(), settled = new Set();\n  const add = (u) => {\n    const n = u?.cost?.total;\n    const reported = u?.cost?.source === 'provider-reported';\n    const provided = reported || u?.cost?.source === 'provider-estimate';\n    const tokens = [u?.input,u?.output,u?.cacheRead,u?.cacheWrite].some(v => Number.isFinite(v) && v > 0);\n    if (!provided && !tokens || !Number.isFinite(n) || n < 0 || n === 0 && !provided) { unknown = true; return; }\n    seen = true; total += n; estimate ||= !reported;\n  };\n  const nestedCost = (nodes, depth = 0) => {\n    if (!Array.isArray(nodes)) return 0;\n    if (depth > 8) { unknown = true; return 0; }\n    let sum = 0;\n    for (const node of nodes) {\n      const n = node?.totalCost?.costUsd;\n      if (Number.isFinite(n) && n >= 0) sum += n;\n      else { sum += nestedCost(node?.children, depth + 1); for (const step of node?.steps ?? []) sum += nestedCost(step?.children, depth + 1); }\n    }\n    return sum;\n  };\n  const record = (d, terminal) => {\n    if (!d || typeof d !== 'object') return;\n    const root = d.runId || d.asyncId || d.id;\n    if (typeof root !== 'string') return;\n    if (terminal) { pending.delete(root); settled.add(root); }\n    else if (d.asyncId && !settled.has(root)) pending.add(root);\n    if (!Array.isArray(d.results)) return;\n    d.results.forEach((r, index) => {\n      if (!r || typeof r !== 'object') return;\n      const u = r.usage;\n      const key = `${r.runId || root}:${r.runId ? 0 : r.index ?? index}`;\n      const own = typeof u?.cost === 'number' ? u.cost : undefined;\n      const inclusive = r.totalCost?.costUsd;\n      const n = Number.isFinite(own) ? Math.max(own + nestedCost(r.children), Number.isFinite(inclusive) ? inclusive : 0) : inclusive;\n      const tokens = [u?.input,u?.output,u?.cacheRead,u?.cacheWrite].some(v => Number.isFinite(v) && v > 0);\n      // Zero without price provenance is unknown, except attested no-activity startup failures.\n      const zeroActivity = u && [u.input,u.output,u.cacheRead,u.cacheWrite,u.turns].every(v => v === 0);\n      const value = Number.isFinite(n) && n >= 0 ? n : undefined;\n      const old = children.get(key);\n      if (!old || value !== undefined && (old.value === undefined || value >= old.value))\n        children.set(key,{value,unknown:value === undefined || value === 0 && !zeroActivity,estimate:tokens || value > 0});\n    });\n  };\n  for (const e of entries) {\n    const m = e.type === 'message' ? e.message : undefined;\n    if (m?.role === 'toolResult' && m.toolName === 'subagent') record(m.details, !m.details?.asyncId && Array.isArray(m.details?.results) && m.details.results.length > 0);\n    if (e.type === 'custom' && e.customType === 'subagent-cost-v1') record(e.data, true);\n    if (m?.role === 'assistant' && m.provider === 'openai-codex') { subscription = true; continue; }\n    if (m?.role === 'assistant' || m?.role === 'toolResult' && m.toolName !== 'subagent' && m.usage || ['compaction','branch_summary'].includes(e.type)) add(m ? m.usage : e.usage);\n  }\n  for (const c of children.values()) {\n    unknown ||= c.unknown;\n    if (c.value !== undefined) {total += c.value;seen = true;estimate ||= c.estimate;}\n  }\n  unknown ||= pending.size > 0;\n  if (!seen) return subscription ? `sub${unknown ? '+?' : ''}` : '$?';\n  const value = total > 0 && total < 1 ? total.toFixed(6) : total.toFixed(3);\n  return `$${estimate ? '~' : ''}${value}${unknown ? '+?' : ''}${subscription ? ' (sub)' : ''}`;\n}";
const costHelpers = ["cost-evidence.ts", "session-cost.ts"].map(name => fs.readFileSync(new URL("../../extensions/lib/"+name,import.meta.url),"utf8").replace(/^import .*;\n/gm, "").replace(/export function /g, "function ")).join("\n");
export const sessionCostSource = "function formatSessionCost(entries, subscription) {\n" + costHelpers + "\nreturn collectSessionCost(entries,subscription).formatted;\n}";

export const activitySource = fs.readFileSync(new URL("../../extensions/lib/session-metrics.ts", import.meta.url), "utf8").replace("export function collectSessionMetrics", "function collectSessionMetrics").replace(/^.*\n/, "").trim();
// Released V1 helper, before lifecycle accounting and policy-hook filtering.
// The entire extracted helper must match this hash AND its surrounding emitted
// code must match exactly. A marker alone never authorizes replacing local edits.
const legacyActivityHash = '67ccc1390268047f39ce9cf6985d22bbd73f0530606d98aa5c0fcc203e4cd07b';
const activityPrefix = 'const activityMetrics = (';
const activitySuffix = ")(this.session.sessionManager.getEntries(), globalThis[Symbol.for('yunus-pi.metrics-view.v1')]?.(this.session.sessionManager.getSessionId?.()));";
function activityCode(helper, bundled, version) {
  const old = bundled ? ',extensionStatuses=this.footerData.getExtensionStatuses()' : 'const extensionStatuses = this.footerData.getExtensionStatuses()';
  return (bundled ? ';' : '') + `${activityPrefix}${helper}${activitySuffix}
let activityLine = '';
for (const part of activityMetrics.footer) {
  const next = activityLine ? activityLine + ' · ' + part : part;
  if (activityLine && visibleWidth(next) > width) { lines.push(theme.fg('dim', truncateToWidth(activityLine, width))); activityLine = part; }
  else activityLine = next;
}
if (activityLine) lines.push(theme.fg('dim', truncateToWidth(activityLine, width)));
/* PI_SESSION_ACTIVITY_V${version} */ ` + (bundled ? 'let extensionStatuses=this.footerData.getExtensionStatuses()' : old);
}
export function transformActivity(source, bundled) {
  const old = bundled ? ',extensionStatuses=this.footerData.getExtensionStatuses()' : 'const extensionStatuses = this.footerData.getExtensionStatuses()';
  const code = activityCode(activitySource, bundled, 2);
  if (source.includes('PI_SESSION_ACTIVITY_V2') && !source.includes(code)) {
    const start = source.indexOf(activityPrefix), end = source.indexOf(activitySuffix,start+activityPrefix.length);
    const helper = source.slice(start+activityPrefix.length,end);
    // Audited released V2 collectors before skillctx/helper identity and invocation-failure accounting repairs.
    if (['69cb692ba5dc040c678704ac65c57fb15f18590b7aff96e5168285ebd04eec47','61c16b6a591f8438e1fca219d159cf80e4f95a8ebd78aa80dc8220d731f6e4a7','b2171c708285aa3bf92c1ada0ab6a69fe0195b7e27d49e68b81f9f28ed62bc34'].includes(createHash('sha256').update(helper).digest('hex'))) {
      const old = activityCode(helper,bundled,2);
      if (source.split(old).length === 2) source = source.replace(old,()=>code);
    }
  }
  if(source.includes('PI_SESSION_ACTIVITY_V2')) { if(source.split(code).length!==2||source.includes('PI_SESSION_ACTIVITY_V1'))throw Error('session activity postcondition drift'); return source; }
  if(source.includes('PI_SESSION_ACTIVITY_V1')) {
    const start=source.indexOf(activityPrefix), end=source.indexOf(activitySuffix,start+activityPrefix.length);
    if(start<0||end<0)throw Error('session activity V1 migration drift: missing helper boundary');
    const helper=source.slice(start+activityPrefix.length,end);
    if(createHash('sha256').update(helper).digest('hex')!==legacyActivityHash)throw Error('session activity V1 migration drift: unknown helper payload');
    const previous=activityCode(helper,bundled,1);
    if(source.split(previous).length!==2||source.split('PI_SESSION_ACTIVITY_V1').length!==2)throw Error('session activity V1 migration drift: insertion changed');
    return source.replace(previous,()=>code);
  }
  if(source.split(old).length!==2)throw Error('session activity footer anchor drift');
  return source.replace(old,()=>code);
}
const marker = "PI_CACHE_HIT_FOOTER_V1";
const call = `statsParts.push((${cacheHitSource})(this.session.sessionManager.getBranch(), this.session.state.model)); /* ${marker} */`;
const sdkEdits = [
  ["        let latestCacheHitRate;\n", ""],
  [
    "                const latestPromptTokens = entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;\n                latestCacheHitRate =\n                    latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;\n",
    "",
  ],
  [
    "        if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {\n            statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);\n        }",
    `        ${call}`,
  ],
];
const bundleEdits = [
  [",latestCacheHitRate;for(", ";for("],
  [
    "let latestPromptTokens=entry.message.usage.input+entry.message.usage.cacheRead+entry.message.usage.cacheWrite;latestCacheHitRate=latestPromptTokens>0?entry.message.usage.cacheRead/latestPromptTokens*100:void 0",
    "",
  ],
  [
    ",(usageTotals.cacheRead>0||usageTotals.cacheWrite>0)&&latestCacheHitRate!==void 0&&statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);",
    `;${call}`,
  ],
];
const count = (source, text) => source.split(text).length - 1;
export function transformFooter(source, bundled = false) {
  const edits = bundled ? bundleEdits : sdkEdits;
  const legacyCall = `statsParts.push((${legacyCacheHitSource})(this.session.sessionManager.getBranch(), this.session.state.model)); /* ${marker} */`;
  if (source.includes(legacyCall)) source = source.replace(legacyCall, () => call);
  if (source.includes(marker)) {
    if (count(source, call) !== 1 || source.includes("latestCacheHitRate"))
      throw new Error("cache-hit-footer: partial patch or postcondition drift");
    return transformActivity(transformDisplay(source, bundled), bundled);
  }
  for (const [oldText] of edits)
    if (count(source, oldText) !== 1)
      throw new Error(
        `cache-hit-footer: anchor drift: ${oldText.slice(0, 90)}`,
      );
  for (const [oldText, newText] of edits)
    source = source.replace(oldText, () => newText);
  if (source.includes("latestCacheHitRate"))
    throw new Error("cache-hit-footer: unowned cache calculation remains");
  return transformActivity(transformDisplay(source, bundled), bundled);
}

function transformDisplay(source, bundled) {
  for (const old of [previousSessionCostSource, legacySessionCostSource, releasedSessionCostSource]) if (source.includes(old)) source = source.replace(old, () => sessionCostSource);
  const begin = source.indexOf('function formatSessionCost(');
  const end = source.indexOf(')(this.session.sessionManager.getEntries(), usingSubscription)',begin);
  if (begin >= 0 && end > begin) {
    const old = source.slice(begin,end);
    // Exact installed collector immediately before per-model child breakdown.
    if (['1603856a11afd1f7d74071948742364bcaa53d98404dbe2cde0d83ebeb942fc6','4d901db2e4f55ec9d803d1445162365b513d630c21ad50652fa3ef1f35b36df3'].includes(createHash('sha256').update(old).digest('hex')))
      source = source.slice(0,begin) + sessionCostSource + source.slice(end);
  }
  const cost = `(${sessionCostSource})(this.session.sessionManager.getEntries(), usingSubscription)`;
  const oldCost = bundled
    ? 'if(usageTotals.cost||usingSubscription){let costStr=`$${usageTotals.cost.toFixed(3)}${usingSubscription?" (sub)":""}`;statsParts.push(costStr)}'
    : 'if (usageTotals.cost || usingSubscription) {\n            const costStr = `$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`;\n            statsParts.push(costStr);\n        }';
  const priorCost = `statsParts.push(${cost}); /* PI_FOOTER_ACCURACY_V2 */`;
  const newCost = `statsParts.push(${cost} + " total"); /* PI_FOOTER_ACCURACY_V2 */`;
  if (source.includes(priorCost)) source = source.replace(priorCost, () => newCost);
  const pairs = [
    [oldCost, newCost],
    [bundled ? 'contextPercent=contextUsage?.percent!==null?contextPercentValue.toFixed(1):"?"' : 'const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?"',
     bundled ? 'contextPercent=Number.isFinite(contextUsage?.percent)?contextPercentValue.toFixed(1):"?"' : 'const contextPercent = Number.isFinite(contextUsage?.percent) ? contextPercentValue.toFixed(1) : "?"'],
    [bundled ? 'statsLeft=statsParts.join(" ")' : 'let statsLeft = statsParts.join(" ")',
     bundled ? 'statsLeft=statsParts.sort((a,b)=>(a===contextPercentStr?0:a.startsWith("CH")?1:a.startsWith("$")||a==="sub"?2:3)-(b===contextPercentStr?0:b.startsWith("CH")?1:b.startsWith("$")||b==="sub"?2:3)).join(" ")' : 'let statsLeft = statsParts.sort((a,b)=>(a===contextPercentStr?0:a.startsWith("CH")?1:a.startsWith("$")||a==="sub"?2:3)-(b===contextPercentStr?0:b.startsWith("CH")?1:b.startsWith("$")||b==="sub"?2:3)).join(" ")'],
  ];
  if (source.includes('PI_FOOTER_ACCURACY_V2')) {
    for (const [, next] of pairs) if (count(source, next) !== 1) throw Error('footer accuracy postcondition drift: ' + next.slice(0,80) + ' count=' + count(source,next));
    return source;
  }
  for (const [old, next] of pairs) {
    if (count(source, old) !== 1) throw Error('footer accuracy anchor drift: ' + old.slice(0,70));
    source = source.replace(old, () => next);
  }
  return source;
}

export function targets() {
  const core =
    process.env.PI_HARNESS_PATCH_TEST_CORE ??
    path.join(
      execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
      "@earendil-works/pi-coding-agent",
    );
  const sdk = path.join(core, "dist/modes/interactive/components/footer.js");
  const chunks = path.join(core, "dist/bundle/chunks");
  const owners = fs
    .readdirSync(chunks)
    .filter((name) => name.endsWith(".js"))
    .map((name) => path.join(chunks, name))
    .filter((file) =>
      /latestCacheHitRate|PI_CACHE_HIT_FOOTER_V1/.test(
        fs.readFileSync(file, "utf8"),
      ),
    );
  if (!fs.existsSync(sdk) || owners.length !== 1)
    throw new Error("cache-hit-footer: required SDK/unique CLI owner missing");
  const definitions = [
    [sdk, false],
    [owners[0], true],
  ];
  return definitions.map(([file, bundled]) => ({
    name: `cache-hit footer: ${path.relative(core, file)}`,
    file,
    exists: () => fs.existsSync(file),
    isApplied() {
      const source = fs.readFileSync(file, "utf8");
      return (
        source.includes(marker) && transformFooter(source, bundled) === source
      );
    },
    apply() {
      // Preflight both entry points before any mutation; never quietly skip CLI.
      for (const [target, minified] of definitions)
        transformFooter(fs.readFileSync(target, "utf8"), minified);
      const source = fs.readFileSync(file, "utf8");
      const result = transformFooter(source, bundled);
      if (source !== result) fs.writeFileSync(file, result);
    },
  }));
}
