// Optimistic-concurrency edit tool (PI_EDIT_OPTIMISTIC_CONCURRENCY).
//
// The native edit/write path serializes per-file within ONE process, but
// sibling sessions and child writers share one working tree in this harness
// and can change a file between a model's read and its edit. The stock
// failure is a generic "could not find edits[i]" error that costs another
// model round trip and risks an overwrite of the concurrent change.
//
// This patch makes the edit tool revision/hash aware for both bundle
// variants (CLI createEditToolDefinition and SDK createEditTool):
//   * ops may pass expectedHash (the content hash printed by the previous
//     edit of that file). A mismatch means a concurrent writer won the race:
//     NOTHING is written and the error carries the current hash plus a
//     refreshed, line-numbered region around each oldText anchor, so one
//     retry can rebuild oldText from the actual current file.
//   * Without expectedHash, any apply failure (not-found / duplicate /
//     overlap / empty) is enriched with "No file was changed", the current
//     content hash and the same refreshed regions.
//   * Successful edits print the new content hash and expose
//     details.optimisticConcurrency {before, after} for chaining.
// The hash is a deterministic three-lane 96-bit FNV variant (no crypto
// dependency, stable across bundle builds).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const MARKER = "PI_EDIT_OPTIMISTIC_CONCURRENCY";

const DESCRIPTION_OLD =
  'description:"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",';
const DESCRIPTION_NEW =
  'description:"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes. Optimistic concurrency: pass expectedHash=<the content hash printed by your previous edit of this file>; on a mismatch a concurrent writer changed it — nothing is written and the error returns the current hash plus a refreshed line-numbered region to rebuild oldText. Every successful edit prints the new content hash for your next change.",';

// CLI variant (createEditToolDefinition): one continuous statement.
const CLI_OLD =
  'let{bom,text:content}=splitBom(rawContent),originalEnding=detectLineEnding2(content),normalizedContent=normalizeToLF2(content),{baseContent,newContent}=applyEditsToNormalizedContent2(normalizedContent,edits,path13);throwIfAborted();let finalContent=bom+restoreLineEndings2(newContent,originalEnding);await ops.writeFile(absolutePath,finalContent),throwIfAborted();let diffResult=generateDiffString2(baseContent,newContent),patch=generateUnifiedPatch2(path13,baseContent,newContent);return{content:[{type:"text",text:`Successfully replaced ${edits.length} block(s) in ${path13}.`}],details:{diff:diffResult.diff,patch,firstChangedLine:diffResult.firstChangedLine}}';
const CLI_NEW =
  "let{bom,text:content}=splitBom(rawContent),originalEnding=detectLineEnding2(content),normalizedContent=normalizeToLF2(content);/* " +
  MARKER +
  ' */const __piBeforeHash=__piContentHash(normalizedContent),__piConflictHelp=__piEditConflictHelp(normalizedContent,edits);if(typeof input.expectedHash=="string"&&input.expectedHash&&input.expectedHash!==__piBeforeHash)throw new Error(`Edits rejected: ${path13} changed since it was last read (optimistic-concurrency conflict; expected hash ${input.expectedHash}, current ${__piBeforeHash}). No file was changed. Review the refreshed region in this message, then retry once with expectedHash=${__piBeforeHash} after rebuilding oldText from the current file, or ask a true concurrent writer for the lease. ${__piConflictHelp}`);let __piApplyResult;try{__piApplyResult=applyEditsToNormalizedContent2(normalizedContent,edits,path13)}catch(__piEditError){throw new Error(`${__piEditError&&__piEditError.message||String(__piEditError)}\\nNo file was changed. Current content hash: ${__piBeforeHash}. Rebuild oldText from the refreshed region and retry with expectedHash=${__piBeforeHash}. ${__piConflictHelp}`)}const{baseContent,newContent}=__piApplyResult;throwIfAborted();let finalContent=bom+restoreLineEndings2(newContent,originalEnding);await ops.writeFile(absolutePath,finalContent),throwIfAborted();const __piAfterHash=__piContentHash(newContent);let diffResult=generateDiffString2(baseContent,newContent),patch=generateUnifiedPatch2(path13,baseContent,newContent);return{content:[{type:"text",text:`Successfully replaced ${edits.length} block(s) in ${path13}. Content hash now: ${__piAfterHash}. Pass expectedHash=${__piAfterHash} for the next edit of this file so a concurrent writer is detected instead of silently overwritten.`}],details:{diff:diffResult.diff,patch,firstChangedLine:diffResult.firstChangedLine,optimisticConcurrency:{before:__piBeforeHash,after:__piAfterHash}}}';

// SDK variant (createEditTool): result/errors via env2 write flow.
const SDK_OLD =
  'let{bom,text:content}=stripBom2(readResult.value),originalEnding=detectLineEnding(content),normalizedContent=normalizeToLF(content),{baseContent,newContent}=applyEditsToNormalizedContent(normalizedContent,edits,path13);if(context.abortSignal?.aborted)throw new Error("Operation aborted");let finalContent=bom+restoreLineEndings(newContent,originalEnding),writeResult=await env2.writeFile(absolutePath,finalContent,context);if(!writeResult.ok)throw editAccessError(path13,writeResult.error);if(context.abortSignal?.aborted)throw new Error("Operation aborted");let diffResult=generateDiffString(baseContent,newContent);return{content:[{type:"text",text:`Successfully replaced ${edits.length} block(s) in ${path13}.`}],details:{diff:diffResult.diff,patch:generateUnifiedPatch(path13,baseContent,newContent),firstChangedLine:diffResult.firstChangedLine}}';
const SDK_NEW =
  "let{bom,text:content}=stripBom2(readResult.value),originalEnding=detectLineEnding(content),normalizedContent=normalizeToLF(content);/* " +
  MARKER +
  ' */const __piBeforeHash=__piContentHash(normalizedContent),__piConflictHelp=__piEditConflictHelp(normalizedContent,edits);if(typeof input.expectedHash=="string"&&input.expectedHash&&input.expectedHash!==__piBeforeHash)throw new Error(`Edits rejected: ${path13} changed since it was last read (optimistic-concurrency conflict; expected hash ${input.expectedHash}, current ${__piBeforeHash}). No file was changed. Review the refreshed region in this message, then retry once with expectedHash=${__piBeforeHash} after rebuilding oldText from the current file. ${__piConflictHelp}`);let __piApplyResult;try{__piApplyResult=applyEditsToNormalizedContent(normalizedContent,edits,path13)}catch(__piEditError){throw new Error(`${__piEditError&&__piEditError.message||String(__piEditError)}\\nNo file was changed. Current content hash: ${__piBeforeHash}. Rebuild oldText from the refreshed region and retry with expectedHash=${__piBeforeHash}. ${__piConflictHelp}`)}const{baseContent,newContent}=__piApplyResult;if(context.abortSignal?.aborted)throw new Error("Operation aborted");let finalContent=bom+restoreLineEndings(newContent,originalEnding),writeResult=await env2.writeFile(absolutePath,finalContent,context);if(!writeResult.ok)throw editAccessError(path13,writeResult.error);if(context.abortSignal?.aborted)throw new Error("Operation aborted");const __piAfterHash=__piContentHash(newContent);let diffResult=generateDiffString(baseContent,newContent);return{content:[{type:"text",text:`Successfully replaced ${edits.length} block(s) in ${path13}. Content hash now: ${__piAfterHash}. Pass expectedHash=${__piAfterHash} for the next edit of this file so a concurrent writer is detected instead of silently overwritten.`}],details:{diff:diffResult.diff,patch:generateUnifiedPatch(path13,baseContent,newContent),firstChangedLine:diffResult.firstChangedLine,optimisticConcurrency:{before:__piBeforeHash,after:__piAfterHash}}}';

// Shared helpers appended once per patched file (top-level module scope).
// Plain string concatenation only: this text is injected verbatim into a
// minified bundle, so no nested template literals appear in the helpers.
export const HELPERS =
  "" +
  "\n" +
  "function __piContentHash(text){ /* PI_EDIT_OPTIMISTIC_CONCURRENCY:hash */\n" +
  "  let h1=-2128831035,h2=16777619,h3=-1657305572;\n" +
  "  const length=text.length;\n" +
  "  for(let i=0;i<length;i++){const code=text.charCodeAt(i);\n" +
  "    h1=Math.imul(h1^code,16777619);\n" +
  "    h2=Math.imul(h2+code,-1244947197);\n" +
  "    h3=Math.imul(h3^((h1>>>7)^(code<<3)),-1028477379);}\n" +
  "  return (h1>>>0).toString(16).padStart(8,'0')+(h2>>>0).toString(16).padStart(8,'0')+(h3>>>0).toString(16).padStart(8,'0');\n" +
  "}\n" +
  "function __piEditConflictHelp(normalizedContent,edits){ /* PI_EDIT_OPTIMISTIC_CONCURRENCY:conflict */\n" +
  "  try{\n" +
  "    const regions=[];const lines=normalizedContent.split(String.fromCharCode(10));\n" +
  "    for(let i=0;i<Math.min(edits.length,4);i++){\n" +
  "      const oldText=typeof edits[i].oldText==='string'?edits[i].oldText:'';\n" +
  "      const firstLines=oldText.split(String.fromCharCode(10)).filter(function(line){return line.trim().length>=12;});\n" +
  "      const anchor=(firstLines[0]||oldText).trim();\n" +
  "      const probe=anchor.length>24?anchor.slice(0,24):anchor;\n" +
  "      let idx=probe?normalizedContent.indexOf(probe):-1;\n" +
  "      if(idx===-1){regions.push({edit:i,anchorFound:false,hint:'Anchor not present in the current file; re-read the target region.'});continue;}\n" +
  "      let line=1;for(let j=0;j<idx;j++)if(normalizedContent.charCodeAt(j)===10)line++;\n" +
  "      const start=Math.max(0,line-7),end=Math.min(lines.length,line+7);\n" +
  "      const refreshed=[];for(let k=start;k<end;k++){const text=lines[k]||'';refreshed.push((k+1)+': '+(text.length>160?text.slice(0,160)+'\u2026':text));}\n" +
  "      regions.push({edit:i,anchorFound:true,line:line,refreshed:refreshed});\n" +
  "    }\n" +
  "    return '[Refreshed current region(s) for retry: '+JSON.stringify(regions)+']';\n" +
  "  }catch(error){return '[Refreshed current region unavailable; read the file before retrying.]';}\n" +
  "}\n";

function countOnce(source, needle) {
  return source.split(needle).length === 2;
}

export function isAppliedSource(source) {
  return (
    countOnce(source, CLI_NEW) &&
    countOnce(source, SDK_NEW) &&
    countOnce(source, HELPERS) &&
    !source.includes(CLI_OLD) &&
    !source.includes(SDK_OLD) &&
    !source.includes(DESCRIPTION_OLD)
  );
}

export function patchSource(source) {
  if (isAppliedSource(source)) return source;
  if (source.includes(MARKER))
    throw new Error("Edit optimistic-concurrency patch partial/drifted");
  if (!countOnce(source, CLI_OLD)) throw new Error("Edit CLI anchor drift");
  if (!countOnce(source, SDK_OLD)) throw new Error("Edit SDK anchor drift");
  if (source.split(DESCRIPTION_OLD).length !== 3)
    throw new Error("Edit description anchor drift");
  const next =
    source
      .split(CLI_OLD)
      .join(CLI_NEW)
      .split(SDK_OLD)
      .join(SDK_NEW)
      .split(DESCRIPTION_OLD)
      .join(DESCRIPTION_NEW) +
    "\n" +
    HELPERS;
  if (!isAppliedSource(next))
    throw new Error("Edit optimistic-concurrency postcondition failed");
  return next;
}

const EDITS_OWNER_MARKER = "function applyEditsToNormalizedContent2(";

export function targets() {
  const core =
    process.env.PI_HARNESS_PATCH_TEST_CORE ??
    path.join(
      execFileSync("npm", ["root", "-g"], { encoding: "utf-8" }).trim(),
      "@earendil-works/pi-coding-agent",
    );
  const bundle = path.join(core, "dist", "bundle");
  return fs
    .readdirSync(bundle, { recursive: true })
    .filter((file) => typeof file === "string" && file.endsWith(".js"))
    .map((file) => path.join(bundle, file))
    .filter((file) =>
      fs.readFileSync(file, "utf-8").includes(EDITS_OWNER_MARKER),
    )
    .map((file) => ({
      name: `edit tool optimistic concurrency (${path.basename(file)})`,
      file,
      exists: () => fs.existsSync(file),
      isApplied: () => isAppliedSource(fs.readFileSync(file, "utf-8")),
      apply: () => {
        const source = fs.readFileSync(file, "utf-8");
        if (isAppliedSource(source)) return;
        const next = patchSource(source);
        execFileSync(process.execPath, ["--input-type=module", "--check"], {
          input: next,
          stdio: ["pipe", "pipe", "pipe"],
        });
        fs.writeFileSync(file, next);
      },
    }));
}

// Behavioral bench reuses these constants directly.
export const CLI_TEST_BODY = CLI_NEW;
