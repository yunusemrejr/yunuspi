import type { SourceInfo } from "./source-info.ts";
export type SlashCommandSource = "extension" | "prompt" | "skill";
export interface SlashCommandInfo {
    name: string;
    description?: string;
    source: SlashCommandSource;
    sourceInfo: SourceInfo;
    argumentHint?: string;
    /** A boost that combines with the other chainable commands in one message: `/3d /video /noslop make X`. */
    chainable?: boolean;
    /** Works only in the terminal UI. */
    interactiveOnly?: boolean;
}
export interface BuiltinSlashCommand {
    name: string;
    description: string;
    argumentHint?: string;
}
export declare const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand>;
export declare const HIDDEN_SLASH_COMMANDS: readonly string[];

export declare function parseSlashCommand(text: string): { name: string; args: string } | undefined;
