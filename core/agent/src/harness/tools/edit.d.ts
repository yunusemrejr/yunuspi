import { type Static, Type } from "typebox";
import type { AgentHarnessTool } from "../types.ts";
import type { ExecutionToolContext } from "./tool-context.ts";
declare const editSchema: Type.TObject<{
    expectedHash: Type.TOptional<Type.TString>;
    path: Type.TString;
    edits: Type.TArray<Type.TObject<{
        oldText: Type.TString;
        newText: Type.TString;
    }>>;
}>;
export type EditToolInput = Static<typeof editSchema>;
export interface EditToolDetails {
    optimisticConcurrency: { before: string; after: string };
    diff: string;
    patch: string;
    firstChangedLine?: number;
}
export declare function createEditTool<TContext extends ExecutionToolContext = ExecutionToolContext>(): AgentHarnessTool<TContext, typeof editSchema, EditToolDetails | undefined>;
export {};
