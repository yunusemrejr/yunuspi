/**
 * Oversized project notes, sent shorter.
 *
 * A project notes file that sessions keep appending change logs to grows until
 * every request pays for it. The cut here is deterministic, so the prompt cache
 * still holds: a long line keeps its opening and its line number, a long section
 * keeps its head and the range that was left out. The file on disk is never
 * touched. This runs on project files only; the agent directory's own notes are
 * sent whole. `YUNUSPI_SLIM_NOTES=0` sends files as they are.
 */

/** A notes file smaller than this is sent whole (characters). */
export const SLIM_FILE_MIN = 24_000;
const LINE_MAX = 600;
const LINE_KEEP = 240;
const SECTION_MAX = 8_000;

export const slimNotesOn = (value = process.env.YUNUSPI_SLIM_NOTES) => value !== "0";

function cutLine(line, n) {
    if (line.length <= LINE_MAX)
        return line;
    const head = line.slice(0, LINE_KEEP);
    const space = head.lastIndexOf(" ");
    const kept = space > LINE_KEEP * 0.6 ? head.slice(0, space) : head;
    return `${kept} … [+${line.length - kept.length} chars, line ${n}]`;
}

/** One notes file, shortened when it is larger than `SLIM_FILE_MIN`. */
export function slimNotesFile(file, body) {
    if (body.length < SLIM_FILE_MIN)
        return body;
    const lead = /^\n*/.exec(body)[0];
    const tail = /\s*$/.exec(body)[0];
    const lines = body.slice(lead.length, body.length - tail.length).split("\n");
    const out = [];
    let fenced = false;
    let used = 0;
    let skipFrom = 0;
    const closeSection = (lastLine) => {
        if (skipFrom)
            out.push(`[lines ${skipFrom}–${lastLine} of this section are left out here]`);
        skipFrom = 0;
        used = 0;
    };
    lines.forEach((raw, i) => {
        const n = i + 1;
        const fence = /^\s*(```|~~~)/.test(raw);
        // A kept block keeps its closing fence, or every rule after it reads as code.
        const closing = fence && fenced;
        if (fence)
            fenced = !fenced;
        if (!fenced && /^#{1,3} /.test(raw))
            closeSection(i);
        if (skipFrom)
            return;
        const line = fenced || closing ? raw : cutLine(raw, n);
        if (used + line.length > SECTION_MAX && used > 0 && !fenced && !closing) {
            skipFrom = n;
            return;
        }
        used += line.length + 1;
        out.push(line);
    });
    closeSection(lines.length);
    const slim = out.join("\n");
    if (slim.length > body.length * 0.8)
        return body;
    const note = `[The harness shortened this file for the prompt: it is ${Math.round(body.length / 1024)} KB, and every step of the session and every worker would re-read all of it. Cut entries end in "…" with their line number; left-out ranges are given by line. When the task depends on one, Read ${file} at that line. This file is for rules and facts that hold; history belongs in git, so add nothing to it that a commit message already says.]`;
    return `${lead}${slim}\n\n${note}${tail}`;
}
