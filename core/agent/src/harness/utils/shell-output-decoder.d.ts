export type ShellOutputSource = "stdout" | "stderr";
/** Decode each labelled shell pipe separately. Omitted sources form a single stream. */
export declare function createShellOutputDecoder(): {
    append(data: Uint8Array | string, source?: ShellOutputSource): string;
    finish(): string;
};
