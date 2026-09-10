import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
export function patchSource(source){
 const pattern=/function createSummarizationOptions\(([^)]*)\)\s*\{/g;
 const matches=[...source.matchAll(pattern)];if(matches.length!==1)throw Error('summary effort owner drift');
 const args=matches[0][1].split(',').map(s=>s.trim());const thinking=args[6];
 if(!/^[$\w]+$/.test(thinking))throw Error('summary effort signature drift');
 const old=`/* PI_SUMMARY_EFFORT */if(${args[7]}&&${args[7]}!=="off")${args[7]}="low";`;
 if(source.includes(old)) source=source.replace(old,'');
 const insertion=`/* PI_SUMMARY_EFFORT */if(${thinking}&&${thinking}!=="off")${thinking}="low";`;
 if(source.includes('PI_SUMMARY_EFFORT')){if(!source.includes(insertion))throw Error('summary effort partial/drift');return source;}
 const at=matches[0].index+matches[0][0].length;
 return source.slice(0,at)+insertion+source.slice(at);
}
export function targets(){
 const core=process.env.PI_HARNESS_PATCH_TEST_CORE??path.join(execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'@earendil-works/pi-coding-agent');
 const chunkDir=path.join(core,'dist/bundle/chunks');
 const files=[path.join(core,'dist/core/compaction/compaction.js'),...fs.readdirSync(chunkDir).filter(n=>n.endsWith('.js')).map(n=>path.join(chunkDir,n)).filter(f=>fs.readFileSync(f,'utf8').includes('function createSummarizationOptions('))];
 if(files.length!==2)throw Error('summary SDK/CLI owners missing');
 return files.map(file=>({name:'summary effort '+path.basename(file),exists:()=>fs.existsSync(file),isApplied:()=>{const s=fs.readFileSync(file,'utf8');return s.includes('PI_SUMMARY_EFFORT')&&patchSource(s)===s;},apply(){const s=fs.readFileSync(file,'utf8'),next=patchSource(s);if(next===s)return;execFileSync(process.execPath,['--input-type=module','--check'],{input:next});fs.writeFileSync(file,next);}}));
}
