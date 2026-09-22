import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Replace exports atomically, privately, without truncating the source session. */
export function writeSessionExport(outputPath, contents, sourcePath) {
    const target = resolve(outputPath);
    const canonical = path => existsSync(path) ? realpathSync(path) : resolve(path);
    if (sourcePath && canonical(target) === canonical(sourcePath)) {
        throw new Error("Export output must not overwrite the source session");
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const temporaryDir = mkdtempSync(join(dirname(target), ".session-export-"));
    try {
        const temporaryFile = join(temporaryDir, "export");
        writeFileSync(temporaryFile, contents, { encoding: "utf8", mode: 0o600 });
        renameSync(temporaryFile, target);
    } finally {
        rmSync(temporaryDir, { recursive: true, force: true });
    }
    return target;
}
