export interface CommandFix {
    from: string;
    to: string;
}
export interface CommandCorrection {
    /** The input with every fix applied. */
    text: string;
    fixes: CommandFix[];
    /** A leading `/command` with no close match. */
    unknown?: string;
}
export declare function closestCommand(name: string, names: Iterable<string>): string | undefined;
export declare function correctSlashCommands(input: string, options?: {
    commands?: Iterable<string>;
    chainable?: Iterable<string>;
}): CommandCorrection | undefined;
export declare function describeCorrection(fixes: readonly CommandFix[]): string;
