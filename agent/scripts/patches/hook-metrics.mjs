import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
export const wrapper=fs.readFileSync(new URL('./hook-metrics-wrapper.js',import.meta.url),'utf8').trim();
export function transform(source,bundled=false){
 const old=bundled?'list2.push(handler),extension.handlers.set(event,list2)':'list.push(handler);\n            extension.handlers.set(event, list);';
 const next=bundled?`list2.push((${wrapper})(handler,event,extension.path)),extension.handlers.set(event,list2)/* PI_HOOK_METRICS_V1 */`:`list.push((${wrapper})(handler,event,extension.path));\n            extension.handlers.set(event, list); /* PI_HOOK_METRICS_V1 */`;
 if(source.includes('PI_HOOK_METRICS_V1')){if(source.split(next).length!==2)throw Error('hook metrics postcondition drift');return source;}
 if(source.split(old).length!==2)throw Error('hook metrics registration anchor drift');
 return source.replace(old,()=>next);
}
export function targets(){
 const core=process.env.PI_HARNESS_PATCH_TEST_CORE??path.join(execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'@earendil-works/pi-coding-agent');
 const chunks=path.join(core,'dist/bundle/chunks');
 const owners=fs.readdirSync(chunks).filter(n=>n.endsWith('.js')).map(n=>path.join(chunks,n)).filter(p=>fs.readFileSync(p,'utf8').includes('extension.handlers.get(event)'));
 if(owners.length!==1)throw Error('hook metrics requires one CLI owner');
 const defs=[[path.join(core,'dist/core/extensions/loader.js'),false],[owners[0],true]];
 return defs.map(([file,bundled])=>({name:`hook metrics: ${path.relative(core,file)}`,file,exists:()=>fs.existsSync(file),isApplied(){const s=fs.readFileSync(file,'utf8');return s.includes('PI_HOOK_METRICS_V1')&&transform(s,bundled)===s;},apply(){for(const [p,b]of defs)transform(fs.readFileSync(p,'utf8'),b);const s=fs.readFileSync(file,'utf8'),n=transform(s,bundled);if(n!==s)fs.writeFileSync(file,n);}}));
}
