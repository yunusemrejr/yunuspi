import { withFileMutationQueue } from "./file-mutation-queue.js";
import { withRegularReadFile } from "@yunuspi/agent-core/node";
import { access } from "node:fs/promises";
import { Type } from "typebox";
import { processImage } from "../../utils/image-process.js";
import { getExperimentalToolSampling } from "../experimental.js";
import { resolveReadPathAsync, resolveToCwd } from "./path-utils.js";
import { annotatePathError } from "./path-hints.js";
import { readRenderers } from "./renderers/read.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.js";
import { spillToolOutput } from "./spill-output.js";
import { documentReadEvidence } from "../guardian/guardian-prose.js";
import { readNativeFile } from "./read-ranges.js";
const readSchema = Type.Object({
    path: Type.String({ description: "Relative or absolute." }),
    offset: Type.Optional(Type.Number({ description: "First line, 1-indexed." })),
    limit: Type.Optional(Type.Number({ description: "Maximum lines." })),
});
export const readToolSystemPromptContribution = {
    snippet: "Read file contents",
    guidelines: ["Use read to examine files instead of cat or sed."],
};
function getNonVisionImageNote(model, path) {
    if (!model || model.input.includes("image")) {
        return undefined;
    }
    return 'Current model does not support images. The image will be omitted from this request; appearance remains unreviewed. Use image_understand({action:"models"}) to discover available vision routes, then image_understand with an explicit permitted provider/model and paths:' + JSON.stringify([path]) + '. Catalog discovery is read-only; inference follows the selected route and cost permissions. Keep the main session model unchanged. Metadata and successful rendering cannot establish visual quality.';
}
export function createReadToolDefinition(cwd, options) {
    const autoResizeImages = options?.autoResizeImages ?? true;
    const ops = options?.operations;
    return {
        name: "read",
        label: "read",
        description: `Read a file. Text is cut at ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB: continue with offset and limit until you have what you need. Images (jpg, png, gif, webp, bmp) are attached. PDF, Word, Excel and PowerPoint files, archives and SQLite databases come back as text or a summary; continue a long PDF with offset=page.`,
        promptSnippet: readToolSystemPromptContribution.snippet,
        promptGuidelines: [...readToolSystemPromptContribution.guidelines],
        parameters: readSchema,
        constrainedSampling: getExperimentalToolSampling(),
        async execute(_toolCallId, { path, offset, limit }, signal, _onUpdate, ctx) {
            return new Promise((resolve, reject) => {
                if (signal?.aborted) {
                    reject(new Error("Operation aborted"));
                    return;
                }
                let aborted = false;
                const onAbort = () => {
                    aborted = true;
                    reject(new Error("Operation aborted"));
                };
                signal?.addEventListener("abort", onAbort, { once: true });
                (async () => {
                    try {
                        const absolutePath = await resolveReadPathAsync(path, ctx?.cwd || cwd);await withFileMutationQueue(absolutePath, async () => { /* PI_NATIVE_READ_MUTATION_QUEUE */
                        if (aborted)
                            return;
                        let buffer;
                        let mimeType;
                        let range;
                        if (ops) {
                            await ops.access(absolutePath);
                            if (aborted)
                                return;
                            mimeType = await ops.detectImageMimeType?.(absolutePath);
                            if (aborted)
                                return;
                            buffer = await ops.readFile(absolutePath);
                        }
                        else {
                            ({ buffer, mimeType, range } = await withRegularReadFile(absolutePath, signal,
                                (file, stats) => readNativeFile(file, stats, offset, limit, signal)));
                        }
                        if (aborted)
                            return;
                        let content;
                        let details;
                        const nonVisionImageNote = getNonVisionImageNote(ctx?.model, absolutePath);
                        if (mimeType) {
                            const processed = await processImage(buffer, mimeType, { autoResizeImages });
                            if (!processed.ok) {
                                let textNote = `Read image file [${mimeType}]\n${processed.message}`;
                                if (nonVisionImageNote)
                                    textNote += `\n${nonVisionImageNote}`;
                                content = [{ type: "text", text: textNote }];
                            }
                            else {
                                let textNote = `Read image file [${processed.mimeType}]`;
                                if (processed.hints.length > 0)
                                    textNote += `\n${processed.hints.join("\n")}`;
                                if (nonVisionImageNote)
                                    textNote += `\n${nonVisionImageNote}`;
                                content = [
                                    { type: "text", text: textNote },
                                    { type: "image", data: processed.data, mimeType: processed.mimeType },
                                ];
                            }
                        }
                        else {
                            const textContent = range?.text ?? buffer.toString("utf-8");
                            const allLines = range ? undefined : textContent.split("\n");
                            const totalFileLines = range?.totalLines ?? allLines.length;
                            // Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
                            const startLine = offset ? Math.max(0, offset - 1) : 0;
                            const startLineDisplay = startLine + 1;
                            // Check if offset is out of bounds.
                            if (startLine >= totalFileLines) {
                                throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
                            }
                            let selectedContent;
                            let userLimitedLines;
                            // If limit is specified by the user, honor it first. Otherwise truncateHead decides.
                            if (range) {
                                selectedContent = range.text;
                                userLimitedLines = range.selectedLines;
                            }
                            else if (limit !== undefined) {
                                const endLine = Math.min(startLine + limit, totalFileLines);
                                selectedContent = allLines.slice(startLine, endLine).join("\n");
                                userLimitedLines = endLine - startLine;
                            }
                            else {
                                selectedContent = allLines.slice(startLine).join("\n");
                            }
                            // Apply truncation, respecting both line and byte limits.
                            const truncation = truncateHead(selectedContent);
                            let outputText;
                            if (truncation.firstLineExceedsLimit) {
                                // First line alone exceeds the byte limit. Point the model at a bash fallback.
                                const firstLine = range ? selectedContent.split("\n", 1)[0] : allLines[startLine];
                                const firstLineSize = formatSize(Buffer.byteLength(firstLine, "utf-8"));
                                outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
                                details = { truncation };
                            }
                            else if (truncation.truncated) {
                                // Truncation occurred. Build an actionable continuation notice.
                                const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
                                const nextOffset = endLineDisplay + 1;
                                outputText = truncation.content;
                                if (truncation.truncatedBy === "lines") {
                                    outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
                                }
                                else {
                                    outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
                                }
                                // Full raw output stays retrievable instead of vanishing at the byte cap.
                                try {
                                    const fullOutputPath = spillToolOutput("pi-read", selectedContent);
                                    details = { truncation, fullOutputPath };
                                    outputText += `\n\n[Full untruncated output: ${fullOutputPath}]`;
                                }
                                catch (error) {
                                    const reason = typeof error?.code === "string" ? ` (${error.code})` : "";
                                    const captureError = `Could not save full read output${reason}.`;
                                    details = { truncation, captureError };
                                    outputText += `\n\n[${captureError}]`;
                                }
                            }
                            else if (userLimitedLines !== undefined && startLine + userLimitedLines < totalFileLines) {
                                // User-specified limit stopped early, but the file still has more content.
                                const remaining = totalFileLines - (startLine + userLimitedLines);
                                const nextOffset = startLine + userLimitedLines + 1;
                                outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
                            }
                            else {
                                // No truncation and no remaining user-limited content.
                                outputText = truncation.content;
                            }
                            content = [{ type: "text", text: outputText }];
                            const documentRead = documentReadEvidence(absolutePath, textContent, startLine === 0 && !truncation.truncated && !truncation.firstLineExceedsLimit && (userLimitedLines === undefined || userLimitedLines >= totalFileLines));
                            if (documentRead) details = { ...details, documentRead };
                        }
                        if (aborted)
                            return;
                        signal?.removeEventListener("abort", onAbort);
                        resolve({ content, details });}); /* PI_NATIVE_READ_QUEUE_END */
                    }
                    catch (error) {
                        let failure = error;
                        // Preserve the missing-path diagnostic while keeping successful reads on the verified descriptor.
                        if (!aborted && !ops && error?.syscall === "open" && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
                            try { await access(error.path); }
                            catch (accessError) {
                                if (accessError?.code === error.code) failure = accessError;
                            }
                        }
                        signal?.removeEventListener("abort", onAbort);
                        if (!aborted) {
                            // Local filesystem only: custom operations (remote hosts) have no local listing to hint from.
                            if (!ops && typeof path === "string")
                                annotatePathError(failure, path, resolveToCwd(path, ctx?.cwd || cwd), ctx?.cwd || cwd);
                            reject(failure);
                        }
                    }
                })();
            });
        },
        ...readRenderers,
    };
}
export function createReadTool(cwd, options) {
    return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
