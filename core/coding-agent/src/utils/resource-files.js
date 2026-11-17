import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

/** Open and validate one descriptor so special files cannot block discovery. */
export function withRegularResourceFile(filePath, read) {
    const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
        const info = fstatSync(fd, { bigint: true });
        if (!info.isFile()) throw new Error("Resource must be a regular file");
        return read(fd, info);
    }
    finally {
        closeSync(fd);
    }
}

function prefixIgnorePattern(line, prefix) {
    const trimmed = line.trim();
    if (!trimmed)
        return null;
    if (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))
        return null;
    let pattern = line;
    let negated = false;
    if (pattern.startsWith("!")) {
        negated = true;
        pattern = pattern.slice(1);
    }
    else if (pattern.startsWith("\\!")) {
        pattern = pattern.slice(1);
    }
    if (pattern.startsWith("/")) {
        pattern = pattern.slice(1);
    }
    const prefixed = prefix ? `${prefix}${pattern}` : pattern;
    return negated ? `!${prefixed}` : prefixed;
}
export function addResourceIgnoreRules(ig, dir, rootDir) {
    const relativeDir = relative(rootDir, dir);
    const prefix = relativeDir ? `${relativeDir.split(sep).join("/")}/` : "";
    for (const filename of IGNORE_FILE_NAMES) {
        const ignorePath = join(dir, filename);
        if (!existsSync(ignorePath))
            continue;
        try {
            const content = withRegularResourceFile(ignorePath, fd => readFileSync(fd, "utf-8"));
            const patterns = content
                .split(/\r?\n/)
                .map((line) => prefixIgnorePattern(line, prefix))
                .filter((line) => Boolean(line));
            if (patterns.length > 0) {
                ig.add(patterns);
            }
        }
        catch { }
    }
}
