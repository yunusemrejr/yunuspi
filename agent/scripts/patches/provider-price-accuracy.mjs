// Price calculation has a single owner shared by SDK and CLI, including Bedrock's inline copy.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
export const calculatorSource = fs.readFileSync(new URL('./calculate-cost.js', import.meta.url), 'utf8').trim();
export const serviceSource = fs.readFileSync(new URL('./openai-service-pricing.js', import.meta.url), 'utf8').trim();
const billingAnchor = 'await this._emitExtensionEvent(event)';
const billingSource = `await this._emitExtensionEvent((/* PI_RESPONSE_BILLING_V1 */
  event.type === 'message_end' && event.message?.role === 'assistant' && event.message.usage?.cost &&
    (event.message.usage.cost.billing = this.modelRuntime.isUsingSubscription(event.message.provider) ? 'subscription' : 'metered'), event))`;
const originals = {"calculator": ["function calculateCost(model, usage) {\n    const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;\n    let rates = model.cost;\n    let matchedThreshold = -1;\n    for (const tier of model.cost.tiers ?? []) {\n        if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {\n            rates = tier;\n            matchedThreshold = tier.inputTokensAbove;\n        }\n    }\n    // Anthropic charges 2x base input for 1h cache writes.\n    const longWrite = usage.cacheWrite1h ?? 0;\n    const shortWrite = usage.cacheWrite - longWrite;\n    usage.cost.input = (rates.input / 1000000) * usage.input;\n    usage.cost.output = (rates.output / 1000000) * usage.output;\n    usage.cost.cacheRead = (rates.cacheRead / 1000000) * usage.cacheRead;\n    usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1000000;\n    usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;\n    return usage.cost;\n}", "function calculateCost(model,usage){let inputTokens=usage.input+usage.cacheRead+usage.cacheWrite,rates=model.cost,matchedThreshold=-1;for(let tier of model.cost.tiers??[])inputTokens>tier.inputTokensAbove&&tier.inputTokensAbove>matchedThreshold&&(rates=tier,matchedThreshold=tier.inputTokensAbove);let longWrite=usage.cacheWrite1h??0,shortWrite=usage.cacheWrite-longWrite;return usage.cost.input=rates.input/1e6*usage.input,usage.cost.output=rates.output/1e6*usage.output,usage.cost.cacheRead=rates.cacheRead/1e6*usage.cacheRead,usage.cost.cacheWrite=(rates.cacheWrite*shortWrite+rates.input*2*longWrite)/1e6,usage.cost.total=usage.cost.input+usage.cost.output+usage.cost.cacheRead+usage.cost.cacheWrite,usage.cost}"], "service": ["function getServiceTierCostMultiplier(model, serviceTier) {\n    switch (serviceTier) {\n        case \"flex\":\n            return 0.5;\n        case \"priority\":\n            return model.id === \"gpt-5.5\" ? 2.5 : 2;\n        default:\n            return 1;\n    }\n}\nfunction applyServiceTierPricing(usage, serviceTier, model) {\n    const multiplier = getServiceTierCostMultiplier(model, serviceTier);\n    if (multiplier === 1)\n        return;\n    usage.cost.input *= multiplier;\n    usage.cost.output *= multiplier;\n    usage.cost.cacheRead *= multiplier;\n    usage.cost.cacheWrite *= multiplier;\n    usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;\n}", "function getServiceTierCostMultiplier(model,serviceTier){switch(serviceTier){case\"flex\":return .5;case\"priority\":return model.id===\"gpt-5.5\"?2.5:2;default:return 1}}function applyServiceTierPricing(usage,serviceTier,model){let multiplier=getServiceTierCostMultiplier(model,serviceTier);multiplier!==1&&(usage.cost.input*=multiplier,usage.cost.output*=multiplier,usage.cost.cacheRead*=multiplier,usage.cost.cacheWrite*=multiplier,usage.cost.total=usage.cost.input+usage.cost.output+usage.cost.cacheRead+usage.cost.cacheWrite)}"]};
export function transform(source, kind) {
  if (kind === 'billing') {
    if (source.split(billingSource).length === 2) return source;
    if (source.split(billingAnchor).length !== 2) throw Error('response billing anchor drift');
    return source.replace(billingAnchor,()=>billingSource);
  }
  const next = kind === 'calculator' ? calculatorSource : serviceSource;
  if (source.includes(next)) {
    if (source.split(next).length !== 2) throw Error('provider pricing duplicate payload');
    return source;
  }
  const released = kind === 'calculator' ? [calculatorSource.replace("        if (tokens > 0 && base.missing?.includes(key)) complete = false;\n", "")] : ["function getServiceTierCostMultiplier(model, serviceTier) {\n    if (serviceTier === 'flex' || serviceTier === 'batch') return 0.5;\n    if (serviceTier === 'priority' || serviceTier === 'fast') return model.id === 'gpt-5.5' ? 2.5 : 2;\n    return 1;\n}\nfunction applyServiceTierPricing(usage, serviceTier, model) {\n    let host = '';\n    try { const url = new URL(model.baseUrl); if (url.protocol === 'https:') host = url.hostname; } catch {}\n    usage.cost.serviceTier = serviceTier ?? 'default';\n    // An OpenAI-compatible wire format does not imply OpenAI's price schedule.\n    if (model.provider !== 'openai' || !['api.openai.com', 'us.api.openai.com', 'eu.api.openai.com'].includes(host)) {\n        if (serviceTier && !['auto', 'default', 'standard'].includes(serviceTier)) usage.cost.complete = false;\n        return;\n    }\n    if (serviceTier && !['auto', 'default', 'standard', 'flex', 'batch', 'priority', 'fast'].includes(serviceTier)) usage.cost.complete = false;\n    let multiplier = getServiceTierCostMultiplier(model, serviceTier);\n    // Official schedule, 2026-09-12. Unknown regional models stay partial.\n    // https://developers.openai.com/api/docs/pricing\n    if (host !== 'api.openai.com') {\n        if (/^(gpt-6-astra|gpt-5\\.6-(sol|terra|luna)|gpt-5\\.[45](?:-mini|-nano|-pro)?)(?:-\\d{4}-\\d{2}-\\d{2})?$/.test(model.id)) multiplier *= 1.1;\n        else usage.cost.complete = false;\n    }\n    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) usage.cost[key] *= multiplier;\n    usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;\n    usage.cost.multiplier = multiplier;\n}"];
  const matches = [...originals[kind],...released].filter(old => source.includes(old));
  if (matches.length !== 1 || source.split(matches[0]).length !== 2) throw Error('provider pricing anchor drift: ' + kind);
  return source.replace(matches[0], () => next);
}
export function targets() {
  const core = process.env.PI_HARNESS_PATCH_TEST_CORE ?? path.join(execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'@earendil-works/pi-coding-agent');
  const ai = path.join(core,'node_modules/@earendil-works/pi-ai/dist');
  const chunks = path.join(core,'dist/bundle/chunks');
  const definitions = [];
  const visit = dir => { for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
    const file = path.join(dir,entry.name);
    if (entry.isDirectory()) { visit(file); continue; }
    if (!entry.name.endsWith('.js')) continue;
    const s = fs.readFileSync(file,'utf8');
    if (s.includes('function calculateCost(')) definitions.push([file,'calculator']);
    // Codex subscription estimates are not metered OpenAI API charges.
    if ((entry.name === 'openai-responses.js' || /^openai-responses-[^.]+\.js$/.test(entry.name)) && s.includes('function applyServiceTierPricing(')) definitions.push([file,'service']);
  } };
  visit(ai); visit(chunks);
  definitions.push([path.join(core,'dist/core/agent-session.js'),'billing']);
  for (const name of fs.readdirSync(chunks).filter(n=>n.endsWith('.js'))) {
    const file=path.join(chunks,name),s=fs.readFileSync(file,'utf8');
    if (s.includes(billingAnchor) || s.includes('PI_RESPONSE_BILLING_V1')) definitions.push([file,'billing']);
  }
  if (definitions.filter(([,kind])=>kind==='billing').length !== 2) throw Error('response billing requires SDK/CLI owners');
  if (!definitions.some(([f,k]) => k === 'calculator' && f === path.join(ai,'models.js')) || definitions.filter(([,k])=>k==='service').length !== 2 || !definitions.some(([f,k])=>k==='calculator' && f.startsWith(chunks))) throw Error('provider pricing required SDK/CLI owners missing');
  return definitions.map(([file,kind]) => ({name:'provider pricing: '+path.relative(core,file),file,kind,exists:()=>fs.existsSync(file),
    isApplied(){const s=fs.readFileSync(file,'utf8');return transform(s,kind)===s;},
    apply(){for(const [f,k] of definitions)transform(fs.readFileSync(f,'utf8'),k);const s=fs.readFileSync(file,'utf8'),next=transform(s,kind);if(next!==s)fs.writeFileSync(file,next);}
  }));
}
