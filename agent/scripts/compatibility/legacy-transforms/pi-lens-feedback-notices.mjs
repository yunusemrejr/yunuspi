// Presentation-only repair. Existing read coverage and edit blocking stay owned
// by ReadGuard; a post-result observation never claims to be a preflight check.
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const file=fileURLToPath(new URL('../../../extensions/pi-lens/dist/index.js',import.meta.url));
export const marker='PI_LENS_FEEDBACK_NOTICES_V1';
export const edits=[
  [
    "message: `\\u26A0 BLIND WRITE \\u2014 editing \\`${filePath ?? \"file\"}\\` without reading in the last ${BLIND_WRITE_WINDOW} tool calls. Read the file first to avoid assumptions.`,",
    "message: `Post-write audit: \\`${filePath ?? \"file\"}\\` changed with no recent tracked read in the last ${BLIND_WRITE_WINDOW} calls. This notice was generated after the mutation; inspect the resulting diff.`, /* PI_LENS_FEEDBACK_NOTICES_V1 */"
  ],
  [
    "\\u{1F504} RETRYABLE \\u2014 Edit without read: you have not read \\`${filePath}\\` in this conversation. Read it first, then retry: \\`read path=\"${filePath}\"\\`.",
    "\\u{1F504} RETRYABLE \\u2014 No verified read-tool coverage for \\`${filePath}\\`. Read the target range with the read tool (or a Lens source-reading tool), then retry. Shell cat/sed/grep output does not establish read-guard coverage. Use: \\`read path=\"${filePath}\"\\`."
  ],
  [
    "${emoji} ${diagnostics.length} warning(s):",
    "${emoji} ${diagnostics.length} advisory diagnostic(s); original rule severity follows:"
  ]
];
export function transform(source){
 if(source.includes(marker)){
  // Exact prerelease two-message payload; the advisory heading was added before release.
  if(edits.slice(0,2).every(([,next])=>source.split(next).length===2)&&source.split(edits[2][0]).length===2)source=source.replace(edits[2][0],()=>edits[2][1]);
  if(!edits.every(([,next])=>source.split(next).length===2))throw Error('Lens feedback notices postcondition drift');return source;
 }
 for(const [old]of edits)if(source.split(old).length!==2)throw Error('Lens feedback notices anchor drift: '+old.slice(0,70));
 for(const [old,next]of edits)source=source.replace(old,()=>next);
 return source;
}
export function targets(){return [{name:'Lens post-write audit and verified-read guidance',file,exists:()=>fs.existsSync(file),isApplied(){const source=fs.readFileSync(file,'utf8');return source.includes(marker)&&transform(source)===source;},apply(){const before=fs.readFileSync(file,'utf8'),after=transform(before);if(after!==before)fs.writeFileSync(file,after);}}];}
