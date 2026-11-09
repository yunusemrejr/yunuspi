import type { AgentTool } from "@yunuspi/agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { type EditRenderState } from "./renderers/edit.ts";
import type { DocumentMutationEvidence } from "../guardian/guardian-prose.js";
declare const editSchema: Type.TObject<{
    expectedHash: Type.TOptional<Type.TString>;
    path: Type.TString;
    edits: Type.TArray<Type.TObject<{
        oldText: Type.TString;
        newText: Type.TString;
    }>>;
}>;
export declare const editToolSystemPromptContribution: {
    readonly snippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call";
    readonly guidelines: readonly ["Use edit for precise changes, with every change to one file in a single call as separate edits[] entries.", "Each edits[].oldText must match the original file exactly (not the file after earlier entries), stay as small as is still unique, and never overlap another entry; merge nearby changes into one."];
};
export type EditToolInput = Static<typeof editSchema>;
export interface EditToolDetails {
    documentMutation?: DocumentMutationEvidence;
    optimisticConcurrency: { before: string; after: string };
    /** Display-oriented diff of the changes made */
    diff: string;
    /** Standard unified patch of the changes made */
    patch: string;
    /** Line number of the first change in the new file (for editor navigation) */
    firstChangedLine?: number;
}
/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
export interface EditOperations {
    /** Read file contents as a Buffer */
    readFile: (absolutePath: string) => Promise<Buffer>;
    /** Write content to a file */
    writeFile: (absolutePath: string, content: string) => Promise<void>;
    /** Check if file is readable and writable (throw if not) */
    access: (absolutePath: string) => Promise<void>;
}
export interface EditToolOptions {
    /** Custom operations for file editing. Default: local filesystem */
    operations?: EditOperations;
}
export declare function createEditToolDefinition(cwd: string, options?: EditToolOptions): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState>;
export declare function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema>;
export {};
