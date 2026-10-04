/**
 * Recovery hints for paths that could not be used.
 *
 * Models invent, mistype and mis-root paths far more often than they misuse any
 * other argument (measured on recorded sessions: a wrong path was the single most
 * common failed read, ls and grep call, and weaker routes repeated it). The bare
 * ENOENT text names the failure but not the way out, so each retry costs a model
 * turn spent on `ls`. These helpers add the way out to the same error message:
 * the nearest directory that exists, spelling/case/extension look-alikes, the
 * same path re-rooted at the working directory, and the same file name elsewhere
 * in the project. They only read directory listings, never file contents, and
 * every walk is bounded in entries, depth and time, so a hint can never turn a
 * cheap failure into an expensive one. All functions return "" when there is
 * nothing useful to add and never throw.
 */
import { readdirSync, statSync } from "node:fs";
import nodePath from "node:path";

/** Build and dependency trees only add noise to a "same name elsewhere" search. */
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", ".hg", ".svn", "__pycache__", ".venv", "venv", ".cache", ".next", "target", "dist", "build"]);
const MAX_LISTED_ENTRIES = 14;
const MAX_SUGGESTIONS = 3;
const SEARCH_ENTRY_BUDGET = 3500;
const SEARCH_TIME_BUDGET_MS = 150;
const SEARCH_MAX_DEPTH = 5;
const MAX_ENTRIES_READ_PER_DIRECTORY = 4000;

function statOf(path) {
    try {
        return statSync(path);
    }
    catch {
        return undefined;
    }
}
function listDirectory(path) {
    try {
        return readdirSync(path, { withFileTypes: true }).slice(0, MAX_ENTRIES_READ_PER_DIRECTORY);
    }
    catch {
        return [];
    }
}
function foldName(name) {
    return String(name).normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}
function stemOf(name) {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
}
/** Levenshtein distance, or undefined once it is certain to exceed `cap`. */
function boundedDistance(a, b, cap) {
    if (Math.abs(a.length - b.length) > cap)
        return undefined;
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        let rowMinimum = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            const value = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost);
            row[j] = value;
            if (value < rowMinimum)
                rowMinimum = value;
        }
        if (rowMinimum > cap)
            return undefined;
        previous = row;
    }
    return previous[b.length] <= cap ? previous[b.length] : undefined;
}
/**
 * 0..1 likeness of a requested name to an existing entry; 0 means unrelated.
 * 1: identical. .98: only case, separators or unicode form differ. .92: same
 * name with another extension. Up to .9: a typo within a quarter of the length.
 * .7: one name contains the other (plural, prefix).
 */
export function nameSimilarity(wanted, existing) {
    if (wanted === existing)
        return 1;
    const a = foldName(wanted);
    const b = foldName(existing);
    if (!a || !b)
        return 0;
    if (a === b)
        return 0.98;
    const stemA = foldName(stemOf(wanted));
    if (stemA && stemA === foldName(stemOf(existing)))
        return 0.92;
    const longest = Math.max(a.length, b.length);
    const allowed = longest >= 5 ? Math.max(1, Math.floor(longest * 0.25)) : 1;
    const distance = boundedDistance(a, b, allowed);
    if (distance !== undefined)
        return Math.min(0.9, 1 - distance / longest);
    if (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a)))
        return 0.7;
    return 0;
}
/** Deepest ancestor that exists: a directory to list, or a file that blocks the path. */
function nearestExisting(resolved) {
    let current = resolved;
    const missing = [];
    for (let depth = 0; depth < 64; depth++) {
        const stat = statOf(current);
        if (stat)
            return { path: current, isDirectory: stat.isDirectory(), missing: missing.reverse() };
        const parent = nodePath.dirname(current);
        if (parent === current)
            return undefined;
        missing.push(nodePath.basename(current));
        current = parent;
    }
    return undefined;
}
/** Walk the missing segments downward, matching each against the entries that actually exist. */
function resolveFuzzily(start, segments) {
    let beams = [{ path: start, score: 1 }];
    for (let index = 0; index < segments.length; index++) {
        const last = index === segments.length - 1;
        const next = [];
        for (const beam of beams) {
            const scored = [];
            for (const entry of listDirectory(beam.path)) {
                if (!last && !entry.isDirectory())
                    continue;
                const score = nameSimilarity(segments[index], entry.name);
                if (score > 0)
                    scored.push({ name: entry.name, score });
            }
            scored.sort((x, y) => y.score - x.score);
            for (const candidate of scored.slice(0, 3))
                next.push({ path: nodePath.join(beam.path, candidate.name), score: beam.score * candidate.score });
        }
        beams = next.sort((x, y) => y.score - x.score).slice(0, 4);
        if (!beams.length)
            return [];
    }
    return beams;
}
/** The path again, rooted at the working directory: "/src/a.ts" for "./src/a.ts", or a leading project folder name. */
function reRooted(requested, cwd) {
    const segments = String(requested).replace(/\\/g, "/").split("/").filter((part) => part && part !== "." && part !== "~");
    const found = [];
    for (let skip = 0; skip < segments.length; skip++) {
        const candidate = nodePath.join(cwd, ...segments.slice(skip));
        if (statOf(candidate))
            found.push(candidate);
    }
    return found;
}
/** The same file name (case, separators or extension aside) anywhere under `root`, within a fixed budget. */
function sameNameElsewhere(root, wantedName) {
    const found = [];
    const queue = [[root, 0]];
    const started = Date.now();
    let examined = 0;
    while (queue.length && examined < SEARCH_ENTRY_BUDGET && Date.now() - started < SEARCH_TIME_BUDGET_MS) {
        const [directory, depth] = queue.shift();
        for (const entry of listDirectory(directory)) {
            examined++;
            if (nameSimilarity(wantedName, entry.name) >= 0.9)
                found.push(nodePath.join(directory, entry.name));
            if (entry.isDirectory() && depth < SEARCH_MAX_DEPTH && !SKIP_DIRECTORIES.has(entry.name) && !entry.name.startsWith("."))
                queue.push([nodePath.join(directory, entry.name), depth + 1]);
            if (examined >= SEARCH_ENTRY_BUDGET)
                break;
        }
    }
    return found;
}
function sharedTail(a, b) {
    const left = a.split(nodePath.sep);
    const right = b.split(nodePath.sep);
    let shared = 0;
    while (shared < left.length && shared < right.length && left[left.length - 1 - shared] === right[right.length - 1 - shared])
        shared++;
    return shared;
}
function entryNames(directory) {
    const entries = listDirectory(directory)
        .map((entry) => entry.name + (entry.isDirectory() ? "/" : ""))
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    if (!entries.length)
        return "(empty)";
    const shown = entries.slice(0, MAX_LISTED_ENTRIES).join(", ");
    return entries.length > MAX_LISTED_ENTRIES ? `${shown}, … (+${entries.length - MAX_LISTED_ENTRIES} more)` : shown;
}
/**
 * Hint lines for a path that does not exist. `requested` is the model's own
 * text, `resolved` the absolute path that failed, `cwd` the tool's working directory.
 */
export function missingPathHint(requested, resolved, cwd) {
    try {
        const anchor = nearestExisting(resolved);
        if (!anchor)
            return "";
        const suggestions = [];
        const add = (path) => {
            if (path && path !== resolved && !suggestions.includes(path) && statOf(path))
                suggestions.push(path);
        };
        if (anchor.isDirectory) {
            for (const beam of resolveFuzzily(anchor.path, anchor.missing))
                add(beam.path);
        }
        for (const path of reRooted(requested, cwd))
            add(path);
        if (suggestions.length < MAX_SUGGESTIONS) {
            const elsewhere = sameNameElsewhere(cwd, nodePath.basename(resolved))
                .sort((a, b) => sharedTail(b, resolved) - sharedTail(a, resolved));
            for (const path of elsewhere)
                add(path);
        }
        const lines = [];
        if (anchor.isDirectory)
            lines.push(`Nearest existing directory: ${anchor.path}`);
        else
            lines.push(`${anchor.path} is a file, so nothing can exist below it.`);
        if (suggestions.length) {
            lines.push(`Did you mean: ${suggestions.slice(0, MAX_SUGGESTIONS).join(" | ")}`);
        }
        else if (anchor.isDirectory) {
            lines.push(`It contains: ${entryNames(anchor.path)}`);
        }
        return lines.join("\n");
    }
    catch {
        return "";
    }
}
/** For read on a directory (EISDIR): say what it is and show what is inside. */
export function directoryReadHint(resolved) {
    try {
        if (!statOf(resolved)?.isDirectory())
            return "";
        return `${resolved} is a directory, not a file. Use ls to list it, or read one of its files. It contains: ${entryNames(resolved)}`;
    }
    catch {
        return "";
    }
}
/** For ls/find/grep given a file where a directory was expected. */
export function fileWhereDirectoryExpectedHint(resolved) {
    try {
        const stat = statOf(resolved);
        if (!stat || stat.isDirectory())
            return "";
        const folder = nodePath.dirname(resolved);
        return `${resolved} is a file (${stat.size} bytes), not a directory. Use read to view it. Its folder ${folder} contains: ${entryNames(folder)}`;
    }
    catch {
        return "";
    }
}
/** Append hint lines under an error's own text, leaving the original first line untouched. */
export function withHint(message, hint) {
    return hint ? `${message}\n${hint}` : message;
}
/**
 * Attach the right hint to a filesystem error in place (code ENOENT/ENOTDIR for a missing path, EISDIR for a
 * directory read as a file). The error object, its code and its first message line are preserved.
 */
export function annotatePathError(error, requested, resolved, cwd) {
    try {
        if (!error || typeof error !== "object" || typeof error.message !== "string" || error.message.includes("Nearest existing directory"))
            return error;
        let hint = "";
        if (error.code === "ENOENT" || error.code === "ENOTDIR")
            hint = missingPathHint(requested, resolved, cwd);
        else if (error.code === "EISDIR")
            hint = directoryReadHint(resolved);
        if (hint)
            error.message = withHint(error.message, hint);
    }
    catch {
        /* Hints are best effort; the original error stands. */
    }
    return error;
}
