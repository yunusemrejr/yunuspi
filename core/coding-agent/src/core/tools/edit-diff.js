/**
 * Shared diff computation utilities for the edit and similar tools.
 */
import * as Diff from "diff";
import { withRegularReadFile } from "@yunuspi/agent-core/node";
import { splitBom } from "../../utils/text.js";
import { resolveToCwd } from "./path-utils.js";
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export function decodeEditText(bytes) {
    try {
        return utf8.decode(bytes);
    }
    catch (cause) {
        throw new Error("Edit requires a valid UTF-8 text file. No file was changed.", { cause });
    }
}
export function detectLineEnding(content) {
    const crlfIdx = content.indexOf("\r\n");
    const lfIdx = content.indexOf("\n");
    if (lfIdx === -1)
        return "\n";
    if (crlfIdx === -1)
        return "\n";
    return crlfIdx < lfIdx ? "\r\n" : "\n";
}
export function normalizeToLF(text) {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
export function restoreLineEndings(text, ending) {
    return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}
/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text) {
    return normalizeFuzzyPunctuation(text.normalize("NFKC").split("\n").map(line => line.trimEnd()).join("\n"));
}
function normalizeFuzzyPunctuation(text) {
    return text
        // Smart single quotes → '
        .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
        // Smart double quotes → "
        .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
        // Various dashes/hyphens → -
        // U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
        // U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
        .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
        // Special spaces → regular space
        // U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
        // U+205F medium math space, U+3000 ideographic space
        .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}
function splitLinesWithEndings(content) {
    return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}
function getLineSpans(content) {
    let offset = 0;
    return splitLinesWithEndings(content).map((line) => {
        const span = { start: offset, end: offset + line.length };
        offset = span.end;
        return span;
    });
}
function getReplacementLineRange(lines, replacement) {
    const replacementStart = replacement.matchIndex;
    const replacementEnd = replacement.matchIndex + replacement.matchLength;
    let startLine = -1;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (replacementStart >= line.start && replacementStart < line.end) {
            startLine = i;
            break;
        }
    }
    if (startLine === -1) {
        throw new Error("Replacement range is outside the base content.");
    }
    let endLine = startLine;
    while (endLine < lines.length && lines[endLine].end < replacementEnd) {
        endLine++;
    }
    if (endLine >= lines.length) {
        throw new Error("Replacement range is outside the base content.");
    }
    return { startLine, endLine: endLine + 1 };
}
function applyReplacements(content, replacements, offset = 0, preserveLogicalBreaks = false) {
    const chunks = [];
    let cursor = 0;
    for (const replacement of replacements) {
        const matchIndex = replacement.matchIndex - offset;
        chunks.push(content.slice(cursor, matchIndex), replacement.newText);
        cursor = matchIndex + replacement.matchLength;
    }
    chunks.push(content.slice(cursor));
    if (!preserveLogicalBreaks)
        return chunks.join("");
    const output = [];
    let endsWithCR = false;
    for (const chunk of chunks) {
        if (!chunk)
            continue;
        // A bare CR and a following LF represent two breaks at a splice.
        // Separate them so normalization sees the same two breaks in the file.
        if (endsWithCR && chunk.startsWith("\n"))
            output.push("\n");
        output.push(chunk);
        endsWithCR = chunk.endsWith("\r");
    }
    return output.join("");
}
/**
 * Apply replacements matched against `baseContent` to `originalContent` while
 * preserving unchanged line blocks from the original.
 *
 * This is useful when `baseContent` is a normalized view of the original. Each
 * replacement is widened to the lines it actually touches, those touched lines
 * are rewritten from the normalized base, and all other lines are copied back
 * from `originalContent`. The actual replacement ranges drive preservation so
 * duplicate normalized lines cannot be aligned to the wrong occurrence.
 */
export function applyReplacementsPreservingUnchangedLines(originalContent, baseContent, replacements) {
    const originalLines = splitLinesWithEndings(originalContent);
    const baseLines = getLineSpans(baseContent);
    if (originalLines.length !== baseLines.length) {
        throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
    }
    const groups = [];
    const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
    for (const replacement of sortedReplacements) {
        const range = getReplacementLineRange(baseLines, replacement);
        const current = groups[groups.length - 1];
        if (current && range.startLine < current.endLine) {
            current.endLine = Math.max(current.endLine, range.endLine);
            current.replacements.push(replacement);
            continue;
        }
        groups.push({ ...range, replacements: [replacement] });
    }
    let originalLineIndex = 0;
    let result = "";
    for (const group of groups) {
        result += originalLines.slice(originalLineIndex, group.startLine).join("");
        const groupStartOffset = baseLines[group.startLine].start;
        const groupEndOffset = baseLines[group.endLine - 1].end;
        result += applyReplacements(baseContent.slice(groupStartOffset, groupEndOffset), group.replacements, groupStartOffset);
        originalLineIndex = group.endLine;
    }
    result += originalLines.slice(originalLineIndex).join("");
    return result;
}
/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * When fuzzy matching is used, the returned contentForReplacement is the
 * fuzzy-normalized version of the content (trailing whitespace stripped,
 * Unicode quotes/dashes normalized to ASCII).
 */
export function fuzzyFindText(content, oldText) {
    // Try exact match first
    const exactIndex = content.indexOf(oldText);
    if (exactIndex !== -1) {
        return {
            found: true,
            index: exactIndex,
            matchLength: oldText.length,
            usedFuzzyMatch: false,
            contentForReplacement: content,
        };
    }
    // Try fuzzy match - work entirely in normalized space
    const fuzzyContent = normalizeForFuzzyMatch(content);
    const fuzzyOldText = normalizeForFuzzyMatch(oldText);
    const fuzzyIndex = fuzzyOldText ? fuzzyContent.indexOf(fuzzyOldText) : -1;
    if (fuzzyIndex === -1) {
        return {
            found: false,
            index: -1,
            matchLength: 0,
            usedFuzzyMatch: false,
            contentForReplacement: content,
        };
    }
    // When fuzzy matching, return offsets in normalized space. Callers can use
    // the normalized content to compute replacements, then decide how much of
    // that normalized output should be written back.
    return {
        found: true,
        index: fuzzyIndex,
        matchLength: fuzzyOldText.length,
        usedFuzzyMatch: true,
        contentForReplacement: fuzzyContent,
    };
}
function countOccurrences(content, oldText, firstMatch) {
    let count = 1;
    for (let at = content.indexOf(oldText, firstMatch + 1); at >= 0; at = content.indexOf(oldText, at + 1))
        count++;
    return count;
}

function lineOffsets(lines) {
    let offset = 0;
    return lines.map(line => {
        const start = offset;
        offset += line.length + 1;
        return start;
    });
}

// Normalization can combine or expand code points (e.g. e + accent or ﬁ).
// Map whole graphemes only and verify that their concatenation agrees with
// the whole-line normalized text before trusting any offset.
let graphemes;
function fuzzyBoundaries(raw, normalized) {
    const offsets = new Map([[0, 0]]);
    const parts = [];
    let offset = 0;
    graphemes ??= new Intl.Segmenter("und", { granularity: "grapheme" });
    for (const { index, segment } of graphemes.segment(raw)) {
        const part = normalizeFuzzyPunctuation(segment.normalize("NFKC"));
        parts.push(part);
        offset += part.length;
        if (offset <= normalized.length)
            offsets.set(offset, index + segment.length);
    }
    return parts.join("").trimEnd() === normalized ? offsets : null;
}

function fuzzySpanMapper(original, normalized) {
    const sourceLines = original.split("\n"), viewLines = normalized.split("\n");
    if (sourceLines.length !== viewLines.length)
        return () => undefined;
    const sourceStarts = lineOffsets(sourceLines), viewStarts = lineOffsets(viewLines);
    const boundaries = new Map();
    return (index, first) => {
        let low = 0, high = viewStarts.length;
        while (low + 1 < high) {
            const middle = (low + high) >>> 1;
            if (viewStarts[middle] <= index) low = middle;
            else high = middle;
        }
        const column = index - viewStarts[low], raw = sourceLines[low], line = viewLines[low];
        if (first && column === line.length && low + 1 < viewLines.length)
            return sourceStarts[low] + raw.length; // the match starts at the newline
        // The punctuation substitutions are one UTF-16 unit each. An ASCII
        // view equal to that result needs no grapheme table, even for long lines.
        if (column === 0 || (/^[\x00-\x7f]*$/.test(line) && normalizeFuzzyPunctuation(raw.trimEnd()) === line))
            return sourceStarts[low] + column;
        if (!boundaries.has(low))
            boundaries.set(low, fuzzyBoundaries(raw, line));
        const offset = boundaries.get(low)?.get(column);
        return offset === undefined ? undefined : sourceStarts[low] + offset;
    };
}
const bigrams = (text) => {
    const grams = new Map();
    for (let i = 0; i < text.length - 1; i++) {
        const gram = text.slice(i, i + 2);
        grams.set(gram, (grams.get(gram) ?? 0) + 1);
    }
    return grams;
};
const dice = (a, b) => {
    let shared = 0, total = 0;
    for (const n of a.values())
        total += n;
    for (const n of b.values())
        total += n;
    for (const [gram, n] of a)
        shared += Math.min(n, b.get(gram) ?? 0);
    return total ? (2 * shared) / total : 0;
};
const HINT_MIN_SIMILARITY = 0.55;
const HINT_MAX_LINES = 12;
const HINT_MAX_FILE_LINES = 20000;
const HINT_MAX_CHARS = 1400;
/**
 * The file's nearest lines to a failed oldText. A model that mistyped one
 * character otherwise re-reads the whole file; the actual lines let it correct
 * the edit in one step. Anchored on the most distinctive old line so a wrong
 * indent or quote on the other lines cannot hide the match.
 */
export function closestLinesHint(content, oldText) {
    const fileLines = content.split("\n");
    if (fileLines.length > HINT_MAX_FILE_LINES)
        return "";
    const oldLines = oldText.split("\n");
    let anchor = -1;
    for (let i = 0; i < oldLines.length; i++) {
        const len = oldLines[i].trim().length;
        if (len >= 8 && (anchor < 0 || len > oldLines[anchor].trim().length))
            anchor = i;
    }
    if (anchor < 0)
        return "";
    const target = bigrams(oldLines[anchor].trim());
    let best = -1, bestScore = 0;
    for (let i = 0; i < fileLines.length; i++) {
        const line = fileLines[i].trim();
        if (line.length < 4)
            continue;
        const score = dice(target, bigrams(line));
        if (score > bestScore) {
            best = i;
            bestScore = score;
        }
    }
    if (best < 0 || bestScore < HINT_MIN_SIMILARITY)
        return "";
    const count = Math.min(oldLines.length, HINT_MAX_LINES);
    const start = Math.max(0, Math.min(best - Math.min(anchor, count - 1), fileLines.length - count));
    const shown = fileLines.slice(start, start + count).map((line, i) => `${start + i + 1}: ${line}`).join("\n");
    return ` Closest text in the file (lines ${start + 1}-${start + count}, ${Math.round(bestScore * 100)}% similar to your oldText):\n${shown.slice(0, HINT_MAX_CHARS)}`;
}
function getNotFoundError(path, editIndex, totalEdits, hint = "") {
    if (totalEdits === 1) {
        return new Error(`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.${hint}`);
    }
    return new Error(`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.${hint}`);
}
function getDuplicateError(path, editIndex, totalEdits, occurrences) {
    if (totalEdits === 1) {
        return new Error(`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`);
    }
    return new Error(`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`);
}
function getEmptyOldTextError(path, editIndex, totalEdits) {
    if (totalEdits === 1) {
        return new Error(`oldText must not be empty in ${path}.`);
    }
    return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}
function getNoChangeError(path, totalEdits) {
    if (totalEdits === 1) {
        return new Error(`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`);
    }
    return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}
/**
 * Overlapping edits in one batch are resolved only when the intent is
 * unambiguous: contained edits must reproduce the outer newText when placed
 * at their original offsets. Partial overlaps must preserve the shared seam.
 */
function resolveOverlappingEdits(sortedEdits, base, path) {
    const endOf = edit => edit.matchIndex + edit.matchLength;
    const lineAt = (offset) => base.slice(0, offset).split("\n").length;
    const lines = (start, end) => {
        const first = lineAt(start), last = lineAt(end - 1);
        return first === last ? `line ${first}` : `lines ${first}-${last}`;
    };
    const describe = (edit) => {
        return `edits[${edit.editIndex}] (${lines(edit.matchIndex, endOf(edit))})`;
    };
    const conflict = (previous, current) => {
        const overlap = lines(current.matchIndex, Math.min(endOf(previous), endOf(current)));
        const combined = lines(previous.matchIndex, Math.max(endOf(previous), endOf(current)));
        return new Error(`${describe(previous)} and ${describe(current)} overlap on ${overlap} in ${path}, and their replacements conflict there. Combine them into one edit whose oldText spans ${combined}.`);
    };
    const appendSibling = (siblings, current) => {
        const previous = siblings.at(-1);
        if (!previous || endOf(previous) <= current.matchIndex) {
            siblings.push(current);
            return;
        }
        const shared = base.slice(current.matchIndex, endOf(previous));
        if (previous.newText.endsWith(shared) && current.newText.startsWith(shared)) {
            siblings[siblings.length - 1] = {
                ...previous,
                matchLength: endOf(current) - previous.matchIndex,
                newText: previous.newText + current.newText.slice(shared.length),
            };
            return;
        }
        throw conflict(previous, current);
    };
    const resolved = [], openRanges = [];
    const finishRange = () => {
        const {edit, children} = openRanges.pop();
        if (children.length) {
            const original = base.slice(edit.matchIndex, endOf(edit));
            if (applyReplacements(original, children, edit.matchIndex) !== edit.newText) {
                if (children.length === 1)
                    throw conflict(edit, children[0]);
                const affected = lines(children[0].matchIndex, endOf(children.at(-1)));
                throw new Error(`${describe(edit)} and its contained edits on ${affected} do not produce the same replacement in ${path}. Combine them into one edit whose oldText spans ${lines(edit.matchIndex, endOf(edit))}.`);
            }
        }
        appendSibling(openRanges.at(-1)?.children ?? resolved, edit);
    };
    // Ranges are sorted outer-first at equal starts. Closing each range before
    // its parent validates every nested edit before it can be coalesced.
    for (const edit of sortedEdits) {
        while (openRanges.length && endOf(edit) > endOf(openRanges.at(-1).edit))
            finishRange();
        const parent = openRanges.at(-1)?.edit;
        if (parent && edit.matchIndex === parent.matchIndex && endOf(edit) === endOf(parent)) {
            if (edit.newText !== parent.newText)
                throw conflict(parent, edit);
            continue;
        }
        openRanges.push({edit, children: []});
    }
    while (openRanges.length)
        finishRange();
    return resolved;
}
/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * Match every edit against the original. An unmatched edit may use a uniquely
 * matched equivalent in a shared normalized view, mapped back to complete
 * source graphemes. Only the requested spans are replaced.
 */
export function applyEditsToNormalizedContent(normalizedContent, edits, path) {
    const { baseContent, newContent } = planEdits(normalizedContent, edits, path);
    return { baseContent, newContent };
}
function planEdits(normalizedContent, edits, path) {
    const normalizedEdits = edits.map((edit) => ({
        oldText: normalizeToLF(edit.oldText),
        newText: normalizeToLF(edit.newText),
    }));
    for (let i = 0; i < normalizedEdits.length; i++) {
        if (normalizedEdits[i].oldText.length === 0) {
            throw getEmptyOldTextError(path, i, normalizedEdits.length);
        }
        if (!normalizedEdits[i].oldText.isWellFormed()) {
            throw new Error(`edits[${i}].oldText must be valid Unicode in ${path}.`);
        }
        if (!normalizedEdits[i].newText.isWellFormed()) {
            throw new Error(`edits[${i}].newText must be valid Unicode in ${path}.`);
        }
    }
    const matchedEdits = [];
    let fuzzyContent, mapSpan;
    for (let i = 0; i < normalizedEdits.length; i++) {
        const edit = normalizedEdits[i];
        let view = normalizedContent, needle = edit.oldText, start = view.indexOf(needle);
        const fuzzy = start < 0;
        if (fuzzy) {
            view = fuzzyContent ??= normalizeForFuzzyMatch(normalizedContent);
            needle = normalizeForFuzzyMatch(needle);
            start = needle ? view.indexOf(needle) : -1;
        }
        if (start < 0) {
            throw getNotFoundError(path, i, normalizedEdits.length, closestLinesHint(normalizedContent, edit.oldText));
        }
        const occurrences = countOccurrences(view, needle, start);
        if (occurrences > 1) {
            throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
        }
        let end = start + needle.length;
        if (fuzzy) {
            mapSpan ??= fuzzySpanMapper(normalizedContent, view);
            start = mapSpan(start, true);
            end = mapSpan(end, false);
            if (start === undefined || end === undefined || end <= start) {
                throw getNotFoundError(path, i, normalizedEdits.length, " The equivalent match did not cover a complete source span.");
            }
        }
        matchedEdits.push({ editIndex: i, matchIndex: start, matchLength: end - start, newText: edit.newText });
    }
    matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex || b.matchLength - a.matchLength);
    const resolvedEdits = resolveOverlappingEdits(matchedEdits, normalizedContent, path);
    const baseContent = normalizedContent;
    const newContent = applyReplacements(baseContent, resolvedEdits);
    if (baseContent === newContent) {
        throw getNoChangeError(path, normalizedEdits.length);
    }
    return { baseContent, newContent, replacements: resolvedEdits };
}

/** Keep original newline bytes outside the resolved edit ranges. */
export function applyEditsWithOriginalLineEndings(content, normalizedContent, edits, path) {
    const { baseContent, newContent, replacements } = planEdits(normalizedContent, edits, path);
    if (content === baseContent)
        return { baseContent, newContent, writeContent: newContent };
    // Only CRLF shrinks when converted to LF. Logical boundaries remain in
    // ascending order, so each removed CR is crossed at most once.
    const crlfOffsets = [];
    for (const match of content.matchAll(/\r\n/g))
        crlfOffsets.push(match.index - crlfOffsets.length);
    let crossed = 0;
    const toSourceOffset = offset => {
        while (crossed < crlfOffsets.length && crlfOffsets[crossed] < offset) crossed++;
        return offset + crossed;
    };
    const ending = content.match(/\r\n|\r|\n/)?.[0] ?? "\n";
    const sourceReplacements = replacements.map(edit => {
        const start = toSourceOffset(edit.matchIndex);
        const end = toSourceOffset(edit.matchIndex + edit.matchLength);
        return { matchIndex: start, matchLength: end - start, newText: edit.newText.replaceAll("\n", ending) };
    });
    return { baseContent, newContent, writeContent: applyReplacements(content, sourceReplacements, 0, true) };
}
// Limit the edit distance explored by Myers. Wholesale replacements can
// outgrow this budget; a single exact hunk still covers every changed byte.
const MAX_EXACT_LINE_DISTANCE = 256;
function linesWithEndings(text) {
    return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
function changedLineRange(oldContent, newContent) {
    const before = linesWithEndings(oldContent);
    const after = linesWithEndings(newContent);
    let start = 0, oldEnd = before.length, newEnd = after.length;
    while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
    while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) {
        oldEnd--;
        newEnd--;
    }
    return { before, after, start, oldEnd, newEnd };
}
function replacementDiffParts(oldContent, newContent) {
    const { before, after, start, oldEnd, newEnd } = changedLineRange(oldContent, newContent);
    const parts = [];
    if (start) parts.push({ value: before.slice(0, start).join("") });
    if (start < oldEnd) parts.push({ value: before.slice(start, oldEnd).join(""), removed: true });
    if (start < newEnd) parts.push({ value: after.slice(start, newEnd).join(""), added: true });
    if (oldEnd < before.length) parts.push({ value: before.slice(oldEnd).join("") });
    return parts;
}
/** Generate a standard unified patch. */
export function generateUnifiedPatch(path, oldContent, newContent, contextLines = 4) {
    const headers = Diff.FILE_HEADERS_ONLY;
    const exact = Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
        context: contextLines,
        headerOptions: headers,
        maxEditLength: MAX_EXACT_LINE_DISTANCE,
    });
    if (exact !== undefined) return exact;

    const { before, after, start, oldEnd, newEnd } = changedLineRange(oldContent, newContent);
    const leading = Math.min(start, contextLines);
    const trailing = Math.min(before.length - oldEnd, contextLines);
    const lines = [];
    const append = (source, first, end, prefix) => {
        for (let index = first; index < end; index++) {
            const line = source[index];
            if (line.endsWith("\n")) lines.push(prefix + line.slice(0, -1));
            else lines.push(prefix + line, "\\ No newline at end of file");
        }
    };
    append(before, start - leading, start, " ");
    append(before, start, oldEnd, "-");
    append(after, start, newEnd, "+");
    append(before, oldEnd, oldEnd + trailing, " ");
    const rangeStart = start - leading + 1;
    return Diff.formatPatch({ oldFileName: path, newFileName: path, hunks: [{
        oldStart: rangeStart, newStart: rangeStart,
        oldLines: leading + oldEnd - start + trailing,
        newLines: leading + newEnd - start + trailing,
        lines,
    }] }, headers);
}
/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(oldContent, newContent, contextLines = 4) {
    const parts = Diff.diffLines(oldContent, newContent, { maxEditLength: MAX_EXACT_LINE_DISTANCE })
        ?? replacementDiffParts(oldContent, newContent);
    const output = [];
    const oldLines = oldContent.split("\n");
    const newLines = newContent.split("\n");
    const maxLineNum = Math.max(oldLines.length, newLines.length);
    const lineNumWidth = String(maxLineNum).length;
    let oldLineNum = 1;
    let newLineNum = 1;
    let lastWasChange = false;
    let firstChangedLine;
    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const raw = part.value.split("\n");
        if (raw[raw.length - 1] === "") {
            raw.pop();
        }
        if (part.added || part.removed) {
            // Capture the first changed line (in the new file)
            if (firstChangedLine === undefined) {
                firstChangedLine = newLineNum;
            }
            // Show the change
            for (const line of raw) {
                if (part.added) {
                    const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
                    output.push(`+${lineNum} ${line}`);
                    newLineNum++;
                }
                else {
                    // removed
                    const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
                    output.push(`-${lineNum} ${line}`);
                    oldLineNum++;
                }
            }
            lastWasChange = true;
        }
        else {
            // Context lines - only show a few before/after changes
            const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
            const hasLeadingChange = lastWasChange;
            const hasTrailingChange = nextPartIsChange;
            if (hasLeadingChange && hasTrailingChange) {
                if (raw.length <= contextLines * 2) {
                    for (const line of raw) {
                        const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
                        output.push(` ${lineNum} ${line}`);
                        oldLineNum++;
                        newLineNum++;
                    }
                }
                else {
                    const leadingLines = raw.slice(0, contextLines);
                    const trailingLines = raw.slice(raw.length - contextLines);
                    const skippedLines = raw.length - leadingLines.length - trailingLines.length;
                    for (const line of leadingLines) {
                        const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
                        output.push(` ${lineNum} ${line}`);
                        oldLineNum++;
                        newLineNum++;
                    }
                    output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
                    oldLineNum += skippedLines;
                    newLineNum += skippedLines;
                    for (const line of trailingLines) {
                        const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
                        output.push(` ${lineNum} ${line}`);
                        oldLineNum++;
                        newLineNum++;
                    }
                }
            }
            else if (hasLeadingChange) {
                const shownLines = raw.slice(0, contextLines);
                const skippedLines = raw.length - shownLines.length;
                for (const line of shownLines) {
                    const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
                    output.push(` ${lineNum} ${line}`);
                    oldLineNum++;
                    newLineNum++;
                }
                if (skippedLines > 0) {
                    output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
                    oldLineNum += skippedLines;
                    newLineNum += skippedLines;
                }
            }
            else if (hasTrailingChange) {
                const skippedLines = Math.max(0, raw.length - contextLines);
                if (skippedLines > 0) {
                    output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
                    oldLineNum += skippedLines;
                    newLineNum += skippedLines;
                }
                for (const line of raw.slice(skippedLines)) {
                    const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
                    output.push(` ${lineNum} ${line}`);
                    oldLineNum++;
                    newLineNum++;
                }
            }
            else {
                // Skip these context lines entirely
                oldLineNum += raw.length;
                newLineNum += raw.length;
            }
            lastWasChange = false;
        }
    }
    return { diff: output.join("\n"), firstChangedLine };
}
/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 */
export async function computeEditsDiff(path, edits, cwd, signal) {
    const absolutePath = resolveToCwd(path, cwd);
    try {
        let bytes;
        try {
            bytes = await withRegularReadFile(absolutePath, signal, file => file.readFile({ signal }));
        }
        catch (error) {
            if (["ENOENT", "ENOTDIR", "EACCES"].includes(error?.code)) {
                return { error: `Could not edit file: ${path}. Error code: ${error.code}.` };
            }
            throw error;
        }
        const rawContent = decodeEditText(bytes);
        // Strip BOM before matching (LLM won't include invisible BOM in oldText)
        const { text: content } = splitBom(rawContent);
        const normalizedContent = normalizeToLF(content);
        const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
        // Generate the diff
        return generateDiffString(baseContent, newContent);
    }
    catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
    }
}
/**
 * Compute the diff for a single edit operation without applying it.
 * Kept as a convenience wrapper for single-edit callers.
 */
export async function computeEditDiff(path, oldText, newText, cwd) {
    return computeEditsDiff(path, [{ oldText, newText }], cwd);
}
