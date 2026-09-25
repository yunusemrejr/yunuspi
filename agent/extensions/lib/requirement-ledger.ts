/**
 * Requirement ledger — deterministic extraction of multi-part user demands.
 *
 * The model-based prompt interpretation is advisory and capped at three
 * entries per list, so the fourth part of a demand could drop silently (a
 * session needed two corrective follow-ups for parts it never tracked). This
 * pure module splits the user's own words into numbered requirements, flags
 * subjective acceptance criteria that need a concrete check, and bounds
 * "don't stop until done" mandates with an explicit definition of done.
 * No inference, no I/O; the literal prompt stays authoritative.
 */
import { promptRequestFocus } from "./prompt-interpretation.ts";

export interface RequirementItem {
	id: string;
	text: string;
}

export interface RequirementLedger {
	/** Open requirements; reported ones are settled out of the ledger. */
	items: RequirementItem[];
	subjective: string[];
	unbounded: boolean;
	/** Last issued id number, so settled ids are never reused. */
	next: number;
}

const MAX_ITEMS = 20;
const MAX_ITEM_CHARS = 200;
/** Directive sentences are only mined from short requests; long pasted
 * charters contribute their explicit list items, never every "should". */
const SENTENCE_MINING_MAX_CHARS = 1_500;

const LIST_ITEM = /^\s*(?:[-*•]|\d{1,2}[.)]|[a-z][.)])\s+(.+)$/i;
const DIRECTIVE = /\b(?:must|should|needs? to|make|add|remove|delete|use|don'?t|do not|never|always|ensure|keep|replace|fix|change|write|create|build|implement|put|move|rename|show|hide|include|exclude|avoid|update|deploy|test|verify)\b/i;
const QUESTION_ONLY = /^\s*(?:what|why|how|who|when|where|which|is|are|can|could|does|do)\b[^.!]*\?\s*$/i;
const SUBJECTIVE = /\b(?:no slop|slop|more visual|visually? (?:rich|stunning|appealing)|premium|elegant|beautiful|polished|modern|clean(?:er)?|professional|high[- ]quality|world[- ]class|perfect|satisf(?:ied|ying)|impressive|delightful|stunning)\b/gi;
const UNBOUNDED = /\b(?:do(?:n'?t| not) stop until|keep going until|until (?:it(?:'?s| is) )?(?:done|finished|perfect|satisf(?:ied|ying))|never stop|until you are satisfied|until i(?:'?m| am) satisfied)\b/i;

const clip = (text: string) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > MAX_ITEM_CHARS ? `${flat.slice(0, MAX_ITEM_CHARS - 1)}…` : flat;
};

/** Requirements stated in one user prompt (ids are assigned by the ledger). */
export function extractRequirements(prompt: string): { items: string[]; subjective: string[]; unbounded: boolean } {
	const focus = promptRequestFocus(String(prompt ?? ""))
		.replace(/<pasted_content\b[^>]*>[\s\S]*?<\/pasted_content\s*>/gi, " ");
	const items: string[] = [];
	const seen = new Set<string>();
	const add = (raw: string) => {
		const text = clip(raw);
		const key = text.toLowerCase();
		if (text.length < 8 || seen.has(key) || QUESTION_ONLY.test(text)) return;
		seen.add(key);
		items.push(text);
	};
	const lines = focus.split(/\r?\n/);
	for (const line of lines) {
		const match = LIST_ITEM.exec(line);
		if (match && !/^#/.test(match[1])) add(match[1]);
	}
	if (focus.length <= SENTENCE_MINING_MAX_CHARS) {
		const prose = lines.filter((line) => !LIST_ITEM.test(line)).join(" ");
		for (const sentence of prose.split(/(?<=[.!?;])\s+|\s+(?:and then|also|plus)\s+/i)) {
			if (DIRECTIVE.test(sentence)) add(sentence);
		}
	}
	const subjective = [...new Set([...focus.matchAll(SUBJECTIVE)].map((match) => match[0].toLowerCase()))].slice(0, 6);
	return { items: items.slice(0, MAX_ITEMS), subjective, unbounded: UNBOUNDED.test(focus) };
}

/** Fold one prompt into the session ledger. A single-part prompt without an
 * unbounded mandate changes nothing: simple work stays simple. */
export function foldRequirements(ledger: RequirementLedger, prompt: string): { ledger: RequirementLedger; added: RequirementItem[] } {
	const found = extractRequirements(prompt);
	if (found.items.length < 2 && !found.unbounded) return { ledger, added: [] };
	const known = new Set(ledger.items.map((item) => item.text.toLowerCase()));
	let next = ledger.next;
	const added = found.items.filter((text) => !known.has(text.toLowerCase())).map((text) => ({ id: `R${++next}`, text }));
	return {
		ledger: {
			items: [...ledger.items, ...added].slice(-MAX_ITEMS),
			subjective: [...new Set([...ledger.subjective, ...found.subjective])].slice(0, 8),
			unbounded: ledger.unbounded || found.unbounded,
			next,
		},
		added,
	};
}

/** Model-only context: the ledger, how subjective criteria become checks, and
 * the definition of done that bounds an open-ended mandate. */
export function renderRequirementLedger(ledger: RequirementLedger): string | undefined {
	if (!ledger.items.length && !ledger.unbounded) return undefined;
	const lines = [
		"Requirement ledger (deterministic split of the user's own words; the literal prompts stay authoritative, and a later correction supersedes the part it changes):",
		...ledger.items.map((item) => `${item.id}: ${item.text}`),
	];
	if (ledger.subjective.length) lines.push(`Subjective criteria (${ledger.subjective.map((s) => `"${s}"`).join(", ")}): before claiming them, define each as a concrete observable check (a rendered capture judged against named criteria, a count, a diff, a test) and record its result.`);
	if (ledger.unbounded) lines.push("Open-ended mandate (\"don't stop until done\"): done means every R# above is met with evidence and every subjective criterion has a recorded check. When that holds, stop and report; do not repeat verified work or re-open settled parts.");
	if (ledger.items.length) lines.push("Final report: map every R# to its evidence, or state plainly that it is not done and why.");
	return lines.join("\n");
}

/** Settle what a final answer reports; the rest stays open and is returned.
 * When nothing stays open the subjective and open-ended flags retire too. */
export function settleRequirements(ledger: RequirementLedger, answer: string): { ledger: RequirementLedger; open: RequirementItem[] } {
	const mentioned = new Set([...String(answer ?? "").matchAll(/\bR(\d{1,3})\b/g)].map((match) => `R${Number(match[1])}`));
	const open = ledger.items.filter((item) => !mentioned.has(item.id));
	return {
		ledger: open.length ? { ...ledger, items: open } : { ...emptyRequirementLedger(), next: ledger.next },
		open,
	};
}

export const emptyRequirementLedger = (): RequirementLedger => ({ items: [], subjective: [], unbounded: false, next: 0 });
