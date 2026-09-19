import { Type } from "typebox";
import { applyEditsToNormalizedContent, detectLineEnding, generateDiffString, generateUnifiedPatch, normalizeToLF, restoreLineEndings, stripBom, } from "./edit-diff.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { resolveToolPath } from "./path-utils.js";
const replaceEditSchema = Type.Object({
    oldText: Type.String({
        description: "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
    }),
    newText: Type.String({ description: "Replacement text for this targeted edit." }),
}, {});
const editSchema = Type.Object({
    expectedHash: Type.Optional(Type.String({ description: "Content hash from the previous edit; a mismatch rejects the write." })),
    path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
    edits: Type.Array(replaceEditSchema, {
        description: "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
    }),
}, {});
function isSingleEditInput(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const edit = value;
    return typeof edit.oldText === "string" && typeof edit.newText === "string";
}
function prepareEditArguments(input) {
    if (!input || typeof input !== "object")
        return input;
    const args = input;
    if (typeof args.edits === "string") {
        try {
            const parsed = JSON.parse(args.edits);
            if (Array.isArray(parsed)) {
                args.edits = parsed;
            }
            else if (isSingleEditInput(parsed)) {
                args.edits = [parsed];
            }
        }
        catch { }
    }
    else if (isSingleEditInput(args.edits)) {
        args.edits = [args.edits];
    }
    const legacy = args;
    if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string")
        return args;
    const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
    edits.push({ oldText: legacy.oldText, newText: legacy.newText });
    const { oldText: _oldText, newText: _newText, ...rest } = legacy;
    return { ...rest, edits };
}
function validateEditInput(input) {
    if (!Array.isArray(input.edits) || input.edits.length === 0) {
        throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
    }
    return { path: input.path, edits: input.edits };
}
function editAccessError(path, error) {
    return new Error(`Could not edit file: ${path}. Error code: ${error.code}.`, { cause: error });
}
export function createEditTool() {
    return {
        name: "edit",
        label: "edit",
        description: "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
        parameters: editSchema,
        prepareArguments: prepareEditArguments,
        async execute(_toolCallId, input, _onUpdate, { env }, _invocation, context) {
            const { path, edits } = validateEditInput(input);
            const absolutePath = await resolveToolPath(env, path, context);
            return withFileMutationQueue(env, absolutePath, async () => {
                if (context.abortSignal?.aborted)
                    throw new Error("Operation aborted");
                const info = await env.fileInfo(absolutePath, context);
                if (!info.ok)
                    throw editAccessError(path, info.error);
                if (info.value.kind !== "file" && info.value.kind !== "symlink") {
                    throw new Error(`Could not edit file: ${path}. Path is not a file.`);
                }
                const readResult = await env.readTextFile(absolutePath, context);
                if (!readResult.ok)
                    throw editAccessError(path, readResult.error);
                if (context.abortSignal?.aborted)
                    throw new Error("Operation aborted");
                const { bom, text: content } = stripBom(readResult.value);
                const originalEnding = detectLineEnding(content);
                const normalizedContent = normalizeToLF(content);
                const beforeHash = __piContentHash(normalizedContent);
                if (typeof input.expectedHash === "string" && input.expectedHash && input.expectedHash !== beforeHash) {
                    throw new Error(`Edits rejected: ${path} changed since it was last read (optimistic-concurrency conflict; expected hash ${input.expectedHash}, current ${beforeHash}). No file was changed. ${__piEditConflictHelp(normalizedContent, edits)}`);
                }
                let result;
                try { result = applyEditsToNormalizedContent(normalizedContent, edits, path); }
                catch (error) { throw new Error(`${error.message}\nNo file was changed. Current content hash: ${beforeHash}. ${__piEditConflictHelp(normalizedContent, edits)}`, { cause: error }); }
                const { baseContent, newContent } = result;
                const afterHash = __piContentHash(newContent);
                if (context.abortSignal?.aborted)
                    throw new Error("Operation aborted");
                const finalContent = bom + restoreLineEndings(newContent, originalEnding);
                const writeResult = await env.writeFile(absolutePath, finalContent, context);
                if (!writeResult.ok)
                    throw editAccessError(path, writeResult.error);
                if (context.abortSignal?.aborted)
                    throw new Error("Operation aborted");
                const diffResult = generateDiffString(baseContent, newContent);
                return {
                    content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}. Content hash now: ${afterHash}. Pass expectedHash=${afterHash} for the next edit of this file.` }],
                    details: {
                        diff: diffResult.diff,
                        patch: generateUnifiedPatch(path, baseContent, newContent),
                        optimisticConcurrency: { before: beforeHash, after: afterHash }, firstChangedLine: diffResult.firstChangedLine,
                    },
                };
            }, context);
        },
    };
}


function __piContentHash(text){ /* PI_EDIT_OPTIMISTIC_CONCURRENCY:hash */
  let h1=-2128831035,h2=16777619,h3=-1657305572;
  const length=text.length;
  for(let i=0;i<length;i++){const code=text.charCodeAt(i);
    h1=Math.imul(h1^code,16777619);
    h2=Math.imul(h2+code,-1244947197);
    h3=Math.imul(h3^((h1>>>7)^(code<<3)),-1028477379);}
  return (h1>>>0).toString(16).padStart(8,'0')+(h2>>>0).toString(16).padStart(8,'0')+(h3>>>0).toString(16).padStart(8,'0');
}
function __piEditConflictHelp(normalizedContent,edits){ /* PI_EDIT_OPTIMISTIC_CONCURRENCY:conflict */
  try{
    const regions=[];const lines=normalizedContent.split(String.fromCharCode(10));
    for(let i=0;i<Math.min(edits.length,4);i++){
      const oldText=typeof edits[i].oldText==='string'?edits[i].oldText:'';
      const firstLines=oldText.split(String.fromCharCode(10)).filter(function(line){return line.trim().length>=12;});
      const anchor=(firstLines[0]||oldText).trim();
      const probe=anchor.length>24?anchor.slice(0,24):anchor;
      let idx=probe?normalizedContent.indexOf(probe):-1;
      if(idx===-1){regions.push({edit:i,anchorFound:false,hint:'Anchor not present in the current file; re-read the target region.'});continue;}
      let line=1;for(let j=0;j<idx;j++)if(normalizedContent.charCodeAt(j)===10)line++;
      const start=Math.max(0,line-7),end=Math.min(lines.length,line+7);
      const refreshed=[];for(let k=start;k<end;k++){const text=lines[k]||'';refreshed.push((k+1)+': '+(text.length>160?text.slice(0,160)+'…':text));}
      regions.push({edit:i,anchorFound:true,line:line,refreshed:refreshed});
    }
    return '[Refreshed current region(s) for retry: '+JSON.stringify(regions)+']';
  }catch(error){return '[Refreshed current region unavailable; read the file before retrying.]';}
}
