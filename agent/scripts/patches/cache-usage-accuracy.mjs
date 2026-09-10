// Wire telemetry provenance + documented Cerebras session affinity.
// Protocol-based: no guessed cache support from model-family names.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const marker = 'PI_CACHE_USAGE_ACCURACY_V1';
const previousMetadata = `usage.cacheReadReported = [rawUsage.prompt_tokens_details?.cached_tokens, rawUsage.prompt_cache_hit_tokens, rawUsage.cached_tokens].some(v => Number.isFinite(v) && v >= 0); /* ${marker} */`;
const previousCharge = `usage.cost.source = 'estimate';
    if (model.provider === 'openrouter' && Number.isFinite(rawUsage.cost) && rawUsage.cost >= 0) {
      let official = false;
      try { official = new URL(model.baseUrl).hostname === 'openrouter.ai'; } catch {}
      if (official) {
        usage.cost.estimatedTotal = usage.cost.total;
        usage.cost.total = rawUsage.cost;
        usage.cost.source = 'provider-reported';
      }
    }`;
const metadata = `${previousMetadata}
    // Some Together-compatible responses report reasoning at the top level.
    // Completion tokens already include it: expose the breakdown, never add it.
    const reasoningCount = rawUsage.completion_tokens_details?.reasoning_tokens ?? rawUsage.reasoning_tokens;
    usage.reasoning = Number.isSafeInteger(reasoningCount) && reasoningCount >= 0 ? Math.min(reasoningCount, usage.output) : 0;`;
const charge = `${previousCharge}
    /* PI_PROVIDER_PRICE_ACCURACY_V3 */
    let billingHost = '';
    try { const u = new URL(model.baseUrl); if (u.protocol === 'https:') billingHost = u.hostname; } catch {}
    if (model.provider === 'deepinfra' && billingHost === 'api.deepinfra.com' && Number.isFinite(rawUsage.estimated_cost) && rawUsage.estimated_cost >= 0) {
      usage.cost.estimatedTotal = usage.cost.total;
      usage.cost.total = rawUsage.estimated_cost;
      usage.cost.source = 'provider-estimate';
    }
    // Published direct-API peak rates, verified 2026-09-10. Exact IDs only.
    // Recognize the catalog snapshot so explicit custom rates still take precedence.
    const peak = model.id === 'deepseek-v4-pro' ? (Date.now() >= Date.parse('2026-09-14T04:00:00Z') ? [0.3, 1.2, 0.006] : [1.32, 3.96, 0.044]) :
      ['deepseek-flash','deepseek-v4-flash','deepseek-v4-flash-vision-exp'].includes(model.id) ? [0.3, 1.2, 0.006] : undefined;
    if (model.provider === 'deepseek' && billingHost === 'api.deepseek.com' && peak &&
        model.cost.input === peak[0] && model.cost.output === peak[1] && model.cost.cacheRead === peak[2] && model.cost.cacheWrite === 0 && !model.cost.tiers?.length) {
      const now = new Date(), day = now.getUTCDay(), hour = now.getUTCHours();
      const atPeak = day >= 1 && day <= 5 && (hour >= 1 && hour < 4 || hour >= 6 && hour < 10);
      if (!atPeak) for (const key of ['input','output','cacheRead','cacheWrite','total']) usage.cost[key] *= 0.5;
      usage.cost.priceBasis = atPeak ? 'deepseek-peak-2026-09-10' : 'deepseek-off-peak-2026-09-10';
    }`;
const legacyAffinity = `if (cacheRetention !== 'none' && model.provider === 'openrouter' && options?.sessionId) {
      let official = false;
      try { official = new URL(model.baseUrl).hostname === 'openrouter.ai'; } catch {}
      if (official) params.session_id = clampOpenAIPromptCacheKey(options.sessionId);
    } /* PI_CACHE_AFFINITY_V1 */`;
const affinity = `if (cacheRetention !== 'none' && model.provider === 'cerebras' && options?.sessionId) {
      let official = false;
      try { official = new URL(model.baseUrl).hostname === 'api.cerebras.ai'; } catch {}
      if (official) params.prompt_cache_key = clampOpenAIPromptCacheKey(options.sessionId);
    } /* PI_CACHE_AFFINITY_V1 */`;
const responseMetadata = `cacheReadReported: Number.isFinite(inputDetails?.cached_tokens) && inputDetails.cached_tokens >= 0, /* ${marker} */`;
const count = (s, x) => s.split(x).length - 1;
export function transform(source, kind, bundled = false) {
  if (kind === 'chat' && source.includes('PI_PROVIDER_PRICE_ACCURACY_V2')) {
    const begin = source.indexOf(previousCharge), end = source.indexOf("\nreturn usage;", begin);
    if (begin < 0 || end < 0) throw Error('cache usage price upgrade: anchor drift');
    source = source.slice(0, begin) + charge + source.slice(end);
  }

  if (kind === 'chat' && source.includes(previousCharge) && !source.includes('PI_PROVIDER_PRICE_ACCURACY_V3')) {
    source = source.replace(previousMetadata, () => metadata).replace(previousCharge, () => charge);
  }
  if (source.includes(legacyAffinity)) source = source.replace(legacyAffinity, () => affinity);
  let edits;
  if (kind === 'chat') {
    const beforeCost = bundled ? 'return calculateCost(model,usage),usage}' : '    calculateCost(model, usage);\n    return usage;';
    const afterCost = `${metadata}\ncalculateCost(model,usage);\n${charge}\nreturn usage;${bundled ? '}' : ''}`;
    const beforeAffinity = bundled ? 'compat.supportsUsageInStreaming!==!1&&(params.stream_options={include_usage:!0})' : '    if (compat.supportsUsageInStreaming !== false) {';
    const afterAffinity = `${affinity}\n${beforeAffinity}`;
    edits = [[beforeCost, afterCost], [beforeAffinity, afterAffinity]];
  } else {
    const old = bundled ? 'cacheRead:cachedTokens,cacheWrite:cacheWriteTokens' : '                cacheRead: cachedTokens,\n                cacheWrite: cacheWriteTokens';
    edits = [[old, `${responseMetadata}\n${old}`]];
  }
  if (source.includes(marker)) {
    for (const [, next] of edits) if (count(source, next) !== 1) throw Error('cache usage accuracy: postcondition drift');
    return source;
  }
  for (const [old, next] of edits) {
    if (count(source, old) !== 1) throw Error('cache usage accuracy: anchor drift ' + old.slice(0,60));
    source = source.replace(old, () => next);
  }
  return source;
}
export function targets() {
  const core = process.env.PI_HARNESS_PATCH_TEST_CORE ?? path.join(execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'@earendil-works/pi-coding-agent');
  const chunks = path.join(core,'dist/bundle/chunks');
  const files = fs.readdirSync(chunks).filter(n=>n.endsWith('.js')).map(n=>path.join(chunks,n));
  const definitions = [];
  for (const [kind, name, unique] of [['chat','openai-completions.js','function parseChunkUsage('],['responses','openai-responses-shared.js','const cachedTokens = inputDetails?.cached_tokens']]) {
    const sdk = path.join(core,'node_modules/@earendil-works/pi-ai/dist/api',name);
    const owners = files.filter(f=>fs.readFileSync(f,'utf8').includes(kind==='chat'?unique:'cachedTokens=inputDetails?.cached_tokens'));
    if (!fs.existsSync(sdk) || owners.length!==1) throw Error(`cache usage accuracy: SDK/CLI owner missing or ambiguous (${kind})`);
    definitions.push([sdk,kind,false],[owners[0],kind,true]);
  }
  return definitions.map(([file,kind,bundled])=>({
    name:`cache usage accuracy: ${path.relative(core,file)}`, file,
    exists:()=>fs.existsSync(file),
    isApplied(){ const s=fs.readFileSync(file,'utf8'); return s.includes(marker)&&transform(s,kind,bundled)===s; },
    apply(){
      for(const [f,k,b] of definitions) transform(fs.readFileSync(f,'utf8'),k,b);
      const s=fs.readFileSync(file,'utf8'), next=transform(s,kind,bundled);
      if(s!==next) fs.writeFileSync(file,next);
    },
  }));
}
