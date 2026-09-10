import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const start = '        if (partiallyApplicable && partiallyApplicable.length > 0) {';
const end = '        if (!editBatchSummary)';
const replacement = '        // PI_LENS_ATOMIC_PREFLIGHT: a rejected batch must never mutate files.\n';
const noteStart = '    const appliedNote = passedEdits.length > 0 ? `';
const noteEnd = '    const header = maxFailCount';
const note = '    const appliedNote = "\\n\\nNo edits were applied. Read the current target region, rebuild the failing oldText, then retry the complete batch. Do not bypass this check with a whole-file overwrite.";\n';
export function isAppliedSource(s) {
  return s.split(replacement).length===2 && s.split(note).length===2 && !s.includes(start) && !s.includes(noteStart);
}
export function patchSource(s) {
  if(isAppliedSource(s)) return s;
  if(s.includes('PI_LENS_ATOMIC_PREFLIGHT') || s.includes(note)) throw Error('Atomic preflight patch partial/drifted');
  for(const anchor of [start,end,noteStart,noteEnd]) if(s.split(anchor).length!==2) throw Error('Atomic preflight anchor drift');
  const a=s.indexOf(start), b=s.indexOf(end,a);
  if(b<a || b-a>10000 || !s.slice(a,b).includes('await applyPartiallyApplicableEdits(')) throw Error('Atomic preflight body drift');
  s=s.slice(0,a)+replacement+s.slice(b);
  const c=s.indexOf(noteStart),d=s.indexOf(noteEnd,c);
  if(d<c || d-c>1000) throw Error('Atomic preflight note drift');
  s=s.slice(0,c)+note+s.slice(d);
  if(!isAppliedSource(s)) throw Error('Atomic preflight postcondition failed');
  return s;
}
export function targets(){
 const file=process.env.PI_HARNESS_PATCH_TEST_LENS ?? path.join(os.homedir(),'.pi/agent/extensions/pi-lens/dist/index.js');
 return [{name:'pi-lens side-effect-free rejected edit batches',exists:()=>fs.existsSync(file),isApplied:()=>isAppliedSource(fs.readFileSync(file,'utf8')),apply(){const s=fs.readFileSync(file,'utf8'),n=patchSource(s);if(s===n)return;execFileSync(process.execPath,['--input-type=module','--check'],{input:n,stdio:['pipe','pipe','pipe']});fs.writeFileSync(file,n);}}];
}
