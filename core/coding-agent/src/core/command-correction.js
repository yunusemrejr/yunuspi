/**
 * Slash-command typo correction, shared by the terminal editor and the desktop app.
 *
 * A mistyped command must never silently become task text or a paid prompt:
 * `/3d /noslop /nobugs make X` used to run without the Nobug boost because the
 * unknown `/nobugs` stayed in the assignment. This module finds the command the
 * user most likely meant so the caller can offer it ("did you mean /nobug?")
 * and replace it in place. It is pure: callers pass the names they know.
 */
/** Leading command token: `/name` followed by whitespace or the end. Names with `:` (skills) or `/` (paths) never match. */
const LEADING = /^(\s*)\/([A-Za-z0-9][\w-]*)(?=\s|$)/;
/** A chained token inside the arguments, bounded like the preset grammar so paths and file names never match. */
const CHAINED = /(?<=^|[\s("'])\/([A-Za-z0-9][\w-]*)(?=$|\s|[,.;:!?)"'](?=$|[\s,.;:!?)"']))/g;
/** Fenced blocks and inline code spans: tokens inside them are text. */
const CODE = /```[\s\S]*?(?:```|$)|(`+)[\s\S]*?(?<!`)\1(?!`)/g;

/** Optimal-string-alignment distance (adjacent swaps count once), stopping early past `limit`. */
function distance(a, b, limit) {
    if (Math.abs(a.length - b.length) > limit)
        return limit + 1;
    let before = null, previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        let best = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            let value = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost);
            if (before && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
                value = Math.min(value, before[j - 2] + 1);
            row.push(value);
            best = Math.min(best, value);
        }
        if (best > limit)
            return limit + 1;
        before = previous;
        previous = row;
    }
    return previous[b.length];
}

/**
 * The known name a mistyped one most likely meant, or undefined when nothing is
 * close or two candidates are equally close. Case-only differences, a unique
 * name the input starts (`/nob` → nobug) and small edits (one for names up to
 * four characters, two beyond) qualify.
 */
export function closestCommand(name, names) {
    const typed = String(name ?? "").toLowerCase();
    if (!typed)
        return undefined;
    const known = [...new Set(names)].filter((candidate) => typeof candidate === "string" && candidate && !candidate.includes(":"));
    const exact = known.find((candidate) => candidate.toLowerCase() === typed);
    if (exact)
        return exact;
    if (typed.length >= 2) {
        const started = known.filter((candidate) => candidate.toLowerCase().startsWith(typed));
        if (started.length === 1)
            return started[0];
    }
    const limit = typed.length <= 4 ? 1 : 2;
    let best, bestScore = limit + 1, tied = false;
    for (const candidate of known) {
        const score = distance(typed, candidate.toLowerCase(), limit);
        if (score < bestScore) {
            best = candidate;
            bestScore = score;
            tied = false;
        }
        else if (score === bestScore && score <= limit)
            tied = true;
    }
    return bestScore <= limit && !tied ? best : undefined;
}

/**
 * Check the commands in a submitted text.
 *
 * - `commands`: every name the leading token may legally be (builtins, extension
 *   commands, prompt templates; skill names are skipped).
 * - `chainable`: the boost names that may also appear later in the text when the
 *   leading command is itself chainable (`/3d /video /noslop make X`).
 *
 * Returns undefined when the text is not a command or every token is known.
 * Otherwise `fixes` lists each replacement made in `text`, `unknown` names a
 * leading command with no close match (the caller decides whether that is an error),
 * and `unrecognized` lists chained tokens that match no boost (`/autonomy`): they
 * would reach the model as plain words, so callers say so before sending.
 */
export function correctSlashCommands(input, { commands = [], chainable = [] } = {}) {
    const raw = String(input ?? "");
    const leading = LEADING.exec(raw);
    if (!leading)
        return undefined;
    const known = new Set(commands);
    const boosts = new Set(chainable);
    const lowerBoosts = new Map([...boosts].map((name) => [name.toLowerCase(), name]));
    const fixes = [], unrecognized = [];
    let head = leading[2], unknown;
    if (!known.has(head)) {
        const meant = closestCommand(head, [...known]);
        if (meant) {
            fixes.push({ from: `/${head}`, to: `/${meant}` });
            head = meant;
        }
        else
            unknown = `/${head}`;
    }
    let text = `${leading[1]}/${head}${raw.slice(leading[0].length)}`;
    if (boosts.has(head)) {
        const start = leading[1].length + head.length + 1;
        const rest = text.slice(start);
        const masked = rest.replace(CODE, (code) => "\u0000".repeat(code.length));
        let out = "", cursor = 0;
        for (const match of masked.matchAll(CHAINED)) {
            const token = match[1];
            if (lowerBoosts.has(token.toLowerCase()))
                continue;
            const meant = closestCommand(token, [...boosts]);
            if (!meant) {
                if (!/^\d+$/.test(token) && !unrecognized.includes(`/${token}`))
                    unrecognized.push(`/${token}`);
                continue;
            }
            const at = match.index ?? 0;
            out += `${rest.slice(cursor, at)}/${meant}`;
            cursor = at + token.length + 1;
            fixes.push({ from: `/${token}`, to: `/${meant}` });
        }
        text = text.slice(0, start) + out + rest.slice(cursor);
    }
    if (!fixes.length && !unknown && !unrecognized.length)
        return undefined;
    return { text, fixes, ...(unknown ? { unknown } : {}), ...(unrecognized.length ? { unrecognized } : {}) };
}

/**
 * Where the commands sit in a text, so a composer can mark them as typed: the leading
 * token, then (when it is chainable) every chained token outside code, each with whether
 * it is a known name. Uses the same grammar as correctSlashCommands.
 */
export function commandTokens(input, { commands = [], chainable = [] } = {}) {
    const raw = String(input ?? "");
    const leading = LEADING.exec(raw);
    if (!leading)
        return [];
    const known = new Set(commands);
    const boosts = new Map([...new Set(chainable)].map((name) => [name.toLowerCase(), name]));
    const head = leading[2], start = leading[1].length;
    const tokens = [{ start, end: leading[0].length, name: head, known: known.has(head), chained: false }];
    if (!boosts.has(head.toLowerCase()) || !known.has(head))
        return tokens;
    const offset = leading[0].length;
    const masked = raw.slice(offset).replace(CODE, (code) => "\u0000".repeat(code.length));
    for (const match of masked.matchAll(CHAINED)) {
        // `/2` is a number, not a command; correctSlashCommands ignores it the same way.
        if (/^\d+$/.test(match[1]))
            continue;
        const at = offset + (match.index ?? 0);
        const name = boosts.get(match[1].toLowerCase());
        tokens.push({ start: at, end: at + match[1].length + 1, name: name ?? match[1], known: !!name, chained: true });
    }
    return tokens;
}

/** One readable line for a correction: "Did you mean /nobug (not /nobugs)?" */
export function describeCorrection(fixes) {
    const parts = fixes.map((fix) => `${fix.to} (not ${fix.from})`);
    return `Did you mean ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]}?`;
}
