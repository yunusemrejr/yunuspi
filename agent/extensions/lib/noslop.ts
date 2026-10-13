/**
 * /noslop — the desloppify aim, as data.
 *
 * The command itself lives in goal.ts and runs on the goal machinery (criteria
 * with evidence, bounded continuations, the completion check); this module is
 * only the brief and the fronts it is judged on. Pure and I/O-free like
 * goal-state.ts, so the wording can be tested without loading an extension.
 *
 * Slop, operationally: anything that is present to look finished, designed or
 * smart rather than to serve the product's user or the code's reader. The
 * test for every element is what concretely gets worse without it. "Less
 * flashy" is not worse.
 */
import { createPresetGoal, type GoalState } from "./goal-state.ts";

/** The fronts a desloppify run is judged on. The goal system adds criterion V. */
export const NOSLOP_CRITERIA: readonly string[] = [
	"Inventory first: in-scope slop listed per front (UI/visual, UI density, copy, comments, dead and duplicate code, structure) with a delete, replace or keep-as-real call on each item, and each screen's element counts, before edits start.",
	"UI and visual slop gone: no fake live/active state, blinking dots, decorative pills, stock gradients/glass, emoji icons, decorative mono fonts, or build/meta narration in the interface; real jobs done plainly in the project's style.",
	"UI density cut on every screen of any UI: only the few KPIs, charts, nav items and panels its user comes for stay; detail moves to its own page, duplicates go, accordions mostly flatten; core design kept; counts before/after.",
	"Copy and labels honest: no made-up labels, SaaS boilerplate, stock phrases, invented metrics or proof, and no text-noise; the text that remains is concrete and no denser than the reader's task needs.",
	"Comments earn their place: code-narrating, thinking-leak, placeholder and commented-out-code comments deleted; only non-obvious why remains (invariant, trade-off, workaround).",
	"Dead and duplicate weight removed: dead code, files, dependencies and scaffolding deleted; duplicated code and duplicated functionality unified behind the surviving implementation.",
	"The cleanup added no slop of its own and broke nothing real: no unrequested abstractions, files or features; genuine state, product behavior and public interfaces unchanged.",
];

const MAX_FOCUS = 500;

/** The user's optional focus text, bounded so a pasted essay cannot become the brief. */
export function noslopFocus(args: string): string {
	const flat = String(args ?? "").replace(/\s+/g, " ").trim();
	return flat.length > MAX_FOCUS ? `${flat.slice(0, MAX_FOCUS - 1)}…` : flat;
}

/**
 * The goal text: what the user asked for, expanded into the working brief the
 * session runs on. Kept self-contained — the target project has no YunusPi
 * docs, so nothing here may point at a file only this repo ships.
 */
export function noslopGoalText(focus: string): string {
	const scope = focus
		? `Requested focus: ${focus}\nDesloppify that area or front deeply. Fronts the focus does not touch get waived with that reason through the goal tool — not silently skipped, and not wandered into.`
		: "Scope: the whole codebase of the current project. Start from the surfaces its users actually see, then work inward to the code.";
	return [
		"Desloppify this codebase: find the AI slop, remove it, and where the slop was doing a real job replace it with the plain, honest thing that does that job.",
		scope,
		"Slop is anything present to look finished, designed or smart instead of serving the product's user or the code's reader. Judge every element by one test: what concretely gets worse for them if it disappears? If the honest answer is nothing, or only \"less flashy\", it goes.",
		"Work these fronts. In the interface: made-up labels and eyebrow pills; fake state such as ACTIVE or LIVE badges, blinking, pulsing or haloed dots, and invented online/ready indicators with no real fact behind them; meta information and build narration leaking into product copy (\"compiled from C++\", \"this section showcases\", how the thing was made instead of what it does); pill-shaped navy or purple labels and badges used as decoration; stock purple-blue gradients, glass panels, glows and ambient blobs; monospace fonts as a costume on text that is not code or data; emojis standing in for icons or bullets; boilerplate SaaS furniture the content never asked for (hero plus three feature cards, testimonial walls, trusted-by strips, manufactured FAQs, newsletter modals, metrics tickers); and text-noise — words that fill space without informing, at a density the reader's task does not need.",
		"A terminal app's interface is its output, so a TUI or CLI gets the same scrutiny: banners and ASCII art nobody reads, status and progress chatter that restates the obvious, a confirmation line for every step, debug logging on by default, emoji bullets, box-drawing frames used as decoration, and colors that decorate instead of signal. Color marks state (error, warning, success), stays legible on dark and light terminals and honors NO_COLOR; output is quiet by default, with detail behind a verbose flag or help.",
		"In copy everywhere (UI text, docs, README, errors): stock phrases and unearned adjectives (seamless, robust, cutting-edge, unlock, elevate), mission-statement filler, rhetorical triads, and any number, metric or endorsement with no real source. What remains says something concrete or is deleted.",
		"In code: comments that narrate the code, restate the next line, leak the author's thinking process, or hold commented-out code and placeholder TODOs — only non-obvious why survives (an invariant, a trade-off, a workaround and its reason). Dead code, dead files, unused dependencies and scaffolding nobody asked for. Duplicated code and duplicated functionality: two implementations of one job collapse into the surviving one, and callers move with them. One-caller abstractions, generic Manager/Service/utils layers around a short flow, and tests that mirror the implementation or cannot fail.",
		"Interface density is its own front: cut it on every screen of any UI or GUI the project has — web, desktop, mobile, terminal. Clutter, noise and text density are slop even when each element is individually honest. Per screen, decide the few things its user comes for and keep only those there; move secondary detail to the page or detail view it belongs to, one obvious step away; delete duplicates, rarely used controls and anything restating what is already visible. As a calibration, not a quota: a dashboard with 20 KPIs, 4 charts, a 10-item sidebar and 10 accordions becomes about 4 KPIs, 2 charts and 5 nav items, with at most one or two accordions, and the rest lives on its own pages or is gone. Shorten labels and helper text, drop redundant captions, dividers, borders and icon decoration, and let whitespace and type hierarchy do the grouping. Keep the project's core design approach — palette, type, layout system, brand — and change it only as far as the reduction needs. Nothing a flow depends on becomes unreachable. Count each screen's visible elements before and after and record the counts as evidence. A project with no UI waives this front with that reason.",
		"Lower density can also mean one good visual instead of many words. Where the subject calls for it (a mechanism, a process, a physical product, an explanatory landing page) or the user asked for it, replace a wall of explanatory text with one crafted figure: scroll-driven motion, or an interactive isometric or 3D figure built with the installed anatomy skill (read it before building; its references/3d.md covers true depth), or three.js when the scene needs a real 3D world. One purposeful piece per page, honoring prefers-reduced-motion and the page's performance budget — never motion or 3D as decoration, and never on utility screens such as settings, forms or data tables.",
		"Rules of engagement. Subtraction first: delete before replacing, and replace only where the element had a real job — then use the plainest honest alternative in the project's own existing style (read the neighboring files first and match them). Real things are not slop: genuine status backed by a fact, earned metrics and testimonials, a deliberate brand system, and containers or motion that carry meaning all stay. Preserve product behavior and public interfaces unless the slop is itself the behavior, the way fake state is. Do not rewrite working code for taste, and do not let the cleanup add slop of its own: no new abstractions, files, features or explanatory comments about the cleanup.",
		"Order of work: inventory the in-scope slop per front first, with a delete, replace or keep-as-real call on each item and each screen's element counts; then fix front by front in reviewable steps; after each front, verify against the real artifact (run the tests or build, open the rendered UI and compare it with how it looked before, read the diff). Record each front's evidence through the goal tool as it settles.",
	].join("\n\n");
}

/** A fresh desloppify goal: the brief as its text, the fronts as its criteria. */
export function createNoslopGoal(focus: string, now = Date.now()): GoalState {
	return createPresetGoal(noslopGoalText(focus), NOSLOP_CRITERIA, now);
}
