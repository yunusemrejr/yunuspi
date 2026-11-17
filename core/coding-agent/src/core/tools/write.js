import { constants } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "path";
import { Type } from "typebox";
import { getExperimentalToolSampling } from "../experimental.js";
import { withFileMutationQueue } from "./file-mutation-queue.js";
import { withNativeFileMutation } from "./native-file-mutation.js";
import { resolveToCwd } from "./path-utils.js";
import { writeRenderers } from "./renderers/write.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { documentMutationEvidence } from "../guardian/guardian-prose.js";
const writeSchema = Type.Object({
    path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
    content: Type.String({ description: "Content to write to the file" }),
});
export const writeToolSystemPromptContribution = {
    snippet: "Create or overwrite files",
    guidelines: ["Use write only for new files or complete rewrites."],
};
export function createWriteToolDefinition(cwd, options) {
    const ops = options?.operations;
    return {
        name: "write",
        label: "write",
        description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
        promptSnippet: writeToolSystemPromptContribution.snippet,
        promptGuidelines: [...writeToolSystemPromptContribution.guidelines],
        parameters: writeSchema,
        constrainedSampling: getExperimentalToolSampling(),
        async execute(_toolCallId, { path, content }, signal, _onUpdate, ctx) {
            if (!content.isWellFormed())
                throw new Error("Write content must be valid Unicode. No file was changed.");
            const absolutePath = resolveToCwd(__piMutationPath(path), ctx?.cwd || cwd);
            const dir = dirname(absolutePath);
            return withFileMutationQueue(absolutePath, async () => {
                // Do not reject from an abort event listener here: that would release the
                // mutation queue while an in-flight filesystem operation may still finish.
                // Check cancellation before committing the write, then keep its receipt.
                const throwIfAborted = () => {
                    if (signal?.aborted)
                        throw new Error("Operation aborted");
                };
                throwIfAborted();
                // Create parent directories if needed.
                if (ops) await ops.mkdir(dir);
                else await mkdir(dir, { recursive: true });
                throwIfAborted();
                // Write the file contents.
                if (ops) await ops.writeFile(absolutePath, content);
                else await withNativeFileMutation(absolutePath, constants.O_WRONLY | constants.O_CREAT, (_file, commit) => commit(content), throwIfAborted);
                const documentMutation = documentMutationEvidence(absolutePath, undefined, content);
                return {
                    content: [{ type: "text", text: `Successfully wrote to ${path}` }],
                    details: documentMutation ? { documentMutation } : undefined,
                };
            }, signal);
        },
        ...writeRenderers,
    };
}
export function createWriteTool(cwd, options) {
    return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
function __piMutationPath(raw) { /* PI_MUTATION_PATH_BOUNDARY */
  if (typeof raw !== "string" || !raw.trim() || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(raw))
    throw new Error("Blocked: invalid filesystem path. Pass a nonempty single-line path without control characters. No file was changed.");
  return raw;
}
