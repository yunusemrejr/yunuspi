// Explicit unlisted-model selection in the native picker. No catalog writes or inference probes.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const previousMethod = String.raw`customModelItem(query) {
  /* PI_CUSTOM_MODEL_PICKER_V1 */
  const value = query.trim();
  if (!value || value.includes('://') || value.length > 256 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]*$/.test(value) || this.isDefaultSearch(value)) return;
  const models = this.allModels.map(item => item.model);
  if (models.some(m => m.id.toLowerCase() === value.toLowerCase() || (m.provider + '/' + m.id).toLowerCase() === value.toLowerCase())) return;
  const providers = [...new Set(models.map(m => m.provider))];
  const slash = value.indexOf('/');
  const explicit = slash > 0 && providers.find(p => p.toLowerCase() === value.slice(0, slash).toLowerCase());
  const provider = explicit || this.currentModel?.provider || (providers.length === 1 ? providers[0] : undefined);
  const id = explicit ? value.slice(slash + 1) : value;
  if (!provider || !id || !providers.includes(provider)) return;
  const base = this.currentModel?.provider === provider ? this.currentModel : models.find(m => m.provider === provider);
  if (!base?.api || !base.baseUrl) return;
  // Carry connection/compatibility settings, never another model's prices or advertised capabilities.
  const contextWindow = Math.min(Number.isSafeInteger(base.contextWindow) && base.contextWindow > 0 ? base.contextWindow : 32768, 32768);
  const maxTokens = Math.min(Number.isSafeInteger(base.maxTokens) && base.maxTokens > 0 ? base.maxTokens : 8192, 8192, contextWindow);
  const model = { provider, id, name: 'Unlisted ID: ' + id + ' — limits/pricing unverified (session only)',
    api: base.api, baseUrl: base.baseUrl, ...(base.headers ? {headers: {...base.headers}} : {}),
    ...(base.compat ? {compat: {...base.compat}} : {}), reasoning: false, input: ['text'],
    contextWindow, maxTokens, cost: {input:0, output:0, cacheRead:0, cacheWrite:0}, piUnlistedModel:true };
  return {provider, id, model};
}`;
// Provider defaults are estimates for a new ID, not claims about its capabilities.
export const customMethod = previousMethod.replace(
  'Math.min(Number.isSafeInteger(base.contextWindow) && base.contextWindow > 0 ? base.contextWindow : 32768, 32768)',
  'Number.isSafeInteger(base.contextWindow) && base.contextWindow > 0 ? base.contextWindow : 131072'
);
// Template substituted with the same picker policy in both installed owners.
function restoreUnlisted(modelRuntime, provider, id) {
  /* PI_UNLISTED_RESTORE_V1 */
  if (!modelRuntime.hasConfiguredAuth(provider)) return;
  const base = modelRuntime.getModels(provider)?.[0];
  if (!base) return;
  return RESTORE_PICKER.customModelItem.call({
    allModels: [{model:base}], currentModel:base, isDefaultSearch:()=>false,
  }, provider + '/' + id)?.model;
}
const restoreSource = restoreUnlisted.toString().replace('RESTORE_PICKER.customModelItem', '({' + customMethod.replace('customModelItem(query)', 'restoreCustomModelItem(query)').replace('PI_CUSTOM_MODEL_PICKER_V1','PI_RESTORE_PICKER_V1') + '}).restoreCustomModelItem');
export function transformRestore(source) {
  const original = 'modelRuntime.getModel(existingSession.model.provider,existingSession.model.modelId)';
  const readable = 'modelRuntime.getModel(existingSession.model.provider, existingSession.model.modelId)';
  const replacement = original + ' ?? (' + restoreSource + ')(modelRuntime,existingSession.model.provider,existingSession.model.modelId)';
  const intermediate = restoreUnlisted.toString().replace('RESTORE_PICKER', '({' + customMethod + '})');
  source=source.replace(intermediate,()=>restoreSource);
  if (source.includes('PI_UNLISTED_RESTORE_V1')) {
    if (count(source,replacement)!==1) throw Error('unlisted restore: partial patch or drift');
    return source;
  }
  const anchor = source.includes(readable) ? readable : original;
  if (count(source,anchor)!==1) throw Error('unlisted restore: upstream anchor drift');
  return source.replace(anchor,()=>replacement);
}
const marker = 'PI_CUSTOM_MODEL_PICKER_V1';
const count = (s,n) => s.split(n).length - 1;
export function transformPicker(source, bundled=false) {
  if (source.includes('PI_UNLISTED_RESTORE_V1')) source=transformRestore(source);
  if (source.includes(previousMethod)) source=source.replace(previousMethod,()=>customMethod);
  const anchor = bundled ? 'filterModels(query){' : '    filterModels(query) {';
  const selected = bundled ? 'this.selectedIndex=query?0:' : '        this.selectedIndex = query ? 0 :';
  const insertion = 'const customItem=this.customModelItem(query);if(customItem)this.filteredModels=[customItem,...this.filteredModels];';
  const save = bundled ? 'selectedModel&&(this.dispose(),this.onSelectAsDefaultCallback(selectedModel.model))' : 'this.dispose();\n                this.onSelectAsDefaultCallback(selectedModel.model);';
  // Enter works immediately; an unverified session route must not masquerade as a durable catalog default.
  const savePatched = bundled
    ? 'selectedModel&&(selectedModel.model.piUnlistedModel?(this.errorMessage="Unlisted models are session-only. Press Enter to use it; configure models.json to save a default.",this.updateList()):(this.dispose(),this.onSelectAsDefaultCallback(selectedModel.model)))'
    : 'if (selectedModel.model.piUnlistedModel) { this.errorMessage="Unlisted models are session-only. Press Enter to use it; configure models.json to save a default."; this.updateList(); return; } this.dispose(); this.onSelectAsDefaultCallback(selectedModel.model);';
  const hint = 'Only showing models from configured providers. Use /login to add providers.';
  const hintNew = 'Type an exact ID to use an unlisted model on the current provider, or provider/model. Arrow keys select catalog matches. /login adds providers.';
  const edits = [[anchor,customMethod+'\n'+anchor], [selected,insertion+selected], [save,savePatched], [hint,hintNew]];
  if (source.includes(marker)) {
    if (count(source,customMethod)!==1 || count(source,insertion)!==1 || count(source,savePatched)!==1 || count(source,hintNew)!==1) throw Error('custom-model-picker: partial patch or drift');
    return source;
  }
  for (const [before] of edits) if (count(source,before)!==1) throw Error('custom-model-picker: upstream anchor drift: '+before.slice(0,80));
  for (const [before,after] of edits) source=source.replace(before,()=>after);
  return source;
}
export function targets() {
  const core=process.env.PI_HARNESS_PATCH_TEST_CORE ?? path.join(execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'@earendil-works/pi-coding-agent');
  const sdk=path.join(core,'dist/modes/interactive/components/model-selector.js'), bundle=path.join(core,'dist/bundle');
  const owners=fs.readdirSync(bundle,{recursive:true}).filter(f=>f.endsWith('.js')).map(f=>path.join(bundle,f)).filter(f=>fs.readFileSync(f,'utf8').includes('getModelSelectorSearchText') && fs.readFileSync(f,'utf8').includes('filterModels(query){'));
  if(!fs.existsSync(sdk)||owners.length!==1)throw Error('custom-model-picker: required SDK/unique CLI owner missing');
  const definitions=[[sdk,false],[owners[0],true],[path.join(core,'dist/core/sdk.js'),false]];
  const transform=(s,file,minified)=>file.endsWith('/core/sdk.js')?transformRestore(s):minified?transformRestore(transformPicker(s,true)):transformPicker(s,false);
  return definitions.map(([file,bundled])=>({name:'Custom model picker: '+path.relative(core,file),file,exists:()=>fs.existsSync(file),
    isApplied(){const s=fs.readFileSync(file,'utf8');return (s.includes(marker)||s.includes('PI_UNLISTED_RESTORE_V1'))&&transform(s,file,bundled)===s;},
    apply(){
      for(const [target,minified] of definitions)execFileSync(process.execPath,['--input-type=module','--check'],{input:transform(fs.readFileSync(target,'utf8'),target,minified),stdio:['pipe','pipe','pipe']});
      const s=fs.readFileSync(file,'utf8'),next=transform(s,file,bundled);if(s===next)return;
      const temp=file+'.picker-'+process.pid+'.tmp';try{fs.writeFileSync(temp,next,{mode:fs.statSync(file).mode&0o777});fs.renameSync(temp,file);}finally{fs.rmSync(temp,{force:true});}
    }}));
}
