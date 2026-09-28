/**
 * Tolerant extraction of one JSON envelope from a reviewer's final message.
 *
 * A reviewer model frequently wraps the required terminal JSON in a sentence,
 * a fenced code block, or both. Extracting the envelope is NOT evidence repair:
 * the caller still validates the assigned-aspect envelope, rejects a missing
 * reviews array, and refuses truncated or empty output. Only a complete,
 * self-contained JSON value is returned, so an unterminated report stays
 * unparseable instead of being completed by guessing.
 */

/** Bound the balanced-brace fallback so a pathological message cannot spend
 * unbounded time; only the first few top-level candidates are ever tried. */
const MAX_BRACE_ATTEMPTS = 32;
const DEFAULT_MAX_CHARS = 40_000;

/** Models sometimes write `\u` or `\'` inside a string as if it were prose.
 * Keeping such a backslash literal changes no reported character, while a
 * strict parse would discard the whole paid report. Valid escapes, including
 * an escaped backslash, are consumed as pairs and left untouched. */
function escapeStrayBackslashes(candidate: string): string {
	return candidate.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})|\\/g, (whole, valid) => valid ? whole : "\\\\");
}

function tryParse(candidate: string): { value: unknown } | undefined {
	if (!candidate) return undefined;
	try {
		return { value: JSON.parse(candidate) };
	} catch {
		const escaped = escapeStrayBackslashes(candidate);
		if (escaped === candidate) return undefined;
		try {
			return { value: JSON.parse(escaped) };
		} catch {
			return undefined;
		}
	}
}

/** End index of the JSON value opened at `start`, respecting string escapes.
 * Returns -1 for an unterminated value (for example a truncated stream). */
export function matchingDelimiter(text: string, start: number): number {
	const open = text[start];
	const close = open === "{" ? "}" : open === "[" ? "]" : "";
	if (!close) return -1;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < text.length; index++) {
		const character = text[index];
		if (inString) {
			if (escaped) { escaped = false; continue; }
			if (character === "\\") { escaped = true; continue; }
			if (character === '"') inString = false;
			continue;
		}
		if (character === '"') { inString = true; continue; }
		if (character === open) depth++;
		else if (character === close) {
			depth--;
			if (depth === 0) return index;
		}
	}
	return -1;
}

/**
 * Return the first complete JSON value found in `text`, or undefined when the
 * text contains no self-contained JSON. Strategy order: the whole trimmed
 * message, then every fenced code block, then the first balanced object/array.
 */
export function extractJsonEnvelope(text: string, maxChars = DEFAULT_MAX_CHARS): unknown | undefined {
	if (typeof text !== "string" || !text) return undefined;
	const bounded = text.length <= maxChars ? text : text.slice(0, maxChars);
	const whole = tryParse(bounded.trim());
	if (whole) return whole.value;
	for (const match of bounded.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
		const fenced = tryParse((match[1] ?? "").trim());
		if (fenced) return fenced.value;
	}
	let attempts = 0;
	for (let index = 0; index < bounded.length && attempts < MAX_BRACE_ATTEMPTS; index++) {
		const character = bounded[index];
		if (character !== "{" && character !== "[") continue;
		const end = matchingDelimiter(bounded, index);
		if (end < 0) continue;
		attempts++;
		const scanned = tryParse(bounded.slice(index, end + 1));
		if (scanned) return scanned.value;
	}
	return undefined;
}

/**
 * Shape an extracted value as the `{reviews: [...]}` dispatch envelope. A
 * reviewer that returns its one report bare, or a report list without the
 * wrapper (including an envelope whose closing `]}` was cut after a complete
 * report), keeps that complete report; each report is still validated per
 * assigned aspect by the caller. Anything else is returned unchanged.
 */
export function asReviewsEnvelope(value: unknown): unknown {
	const isReport = (entry: unknown) => Boolean(entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as { aspect?: unknown }).aspect === "string");
	if (!value || typeof value !== "object") return value;
	if (Array.isArray((value as { reviews?: unknown }).reviews)) return value;
	if (Array.isArray(value)) return value.length && value.every(isReport) ? { reviews: value } : value;
	return isReport(value) ? { reviews: [value] } : value;
}
