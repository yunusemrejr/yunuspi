// Attribute total hook time to tools, including no-op results and failures.
// Existing nested runner phases overlap and must not be added as wall time.
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
const file=fileURLToPath(new URL('../../extensions/pi-lens/dist/index.js',import.meta.url));
export const marker='PI_LENS_TOOL_RESULT_PROFILE_V1';
export const edits=[
 ['    const rtToolName = event?.toolName;',`    const rtToolName = event?.toolName;
    // ${marker}: numeric timing only; never command, path or output content.
    const resultProfileStart = performance.now();
    let resultProfileOutcome = "handler-error";`],
 ['      return await handleToolResult({\n        event,','      const profiledResult = await handleToolResult({\n        event,'],
 [`        sessionId: getStableSessionId(ctx)
      });
    } finally {
      setAmbientAbortSignal(void 0);
    }
  };
  pi.on("tool_result",`, `        sessionId: getStableSessionId(ctx)
      });
      resultProfileOutcome = event.isError === true ? "tool-error" : profiledResult ? "returned" : "unchanged";
      return profiledResult;
    } finally {
      setAmbientAbortSignal(void 0);
      try {
        const durationMs = Math.max(0, performance.now() - resultProfileStart);
        const tool = typeof rtToolName === "string" && /^[a-z0-9_.:-]{1,80}$/i.test(rtToolName) ? rtToolName : "unknown";
        logLatency({ type: "phase", phase: "tool_result_handler", toolName: tool, filePath: "", durationMs, result: resultProfileOutcome });
        globalThis[Symbol.for("yunus-pi.health.v1")]?.("lens.tool_result", { tool, durationMs, outcome: resultProfileOutcome });
      } catch { /* A timing sink cannot change result delivery. */ }
    }
  };
  pi.on("tool_result",`],
];
export function applySource(source){
 if(source.includes(marker)){
  if(!edits.every(([,replacement])=>source.includes(replacement)))throw new Error('Lens result profile postcondition drift');
  return source;
 }
 for(const [anchor,replacement] of edits){
  if(source.split(anchor).length!==2)throw new Error('Lens result profile anchor drift: '+anchor.slice(0,60));
  source=source.replace(anchor,()=>replacement);
 }
 return source;
}
export function targets(){return [{name:'Lens per-tool result timing',file,exists:()=>fs.existsSync(file),isApplied:()=>{
 try{const source=fs.readFileSync(file,'utf8');return source.includes(marker)&&applySource(source)===source;}catch{return false;}
},apply:()=>fs.writeFileSync(file,applySource(fs.readFileSync(file,'utf8')))}];}
if(process.argv[1]===fileURLToPath(import.meta.url)&&process.argv.includes('--fix'))targets()[0].apply();
