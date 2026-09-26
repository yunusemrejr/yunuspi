/**
 * Design-direction protocol for open-ended and visual briefs. Pure module.
 *
 * WHY: an agent given a vague creative brief takes the easiest path, and any
 * site mentioned in the prompt becomes its template. In a music-blog session
 * the user asked for a link to their personal website; the agent copied that
 * site's typography instead of designing for the new brand. Incidental
 * references are context, not style sources, and an open brief deserves a
 * short divergence pass (peers, distinct directions, explicit choice) before
 * building. The guidance is advisory: user words and project conventions win.
 */
import type { PromptAnalysis } from "./prompt-interpretation.ts";

export interface DesignBrief {
	visualDesign: boolean;
	openEnded: boolean;
	styleReferences: string[];
	contextReferences: string[];
	source: "analysis" | "heuristic";
}

const VISUAL_SUBJECT = /\b(?:web ?sites?|landing ?pages?|home ?pages?|web ?apps?|front[- ]?end|user interfaces?|ui|ux|interfaces?|dashboards?|screens?|layouts?|themes?|logos?|brand(?:ing)?|visual identity|posters?|banners?|mockups?|illustrations?|animations?|motion graphics|slides?|decks?|icons?|typography|color palettes?|design systems?|portfolio|storefront|blog)\b/i;
/** New work leaves the direction open; refinement keeps the existing language. */
const NEW_WORK = /\b(?:create|build|make|design|redesign|restyle|develop|craft|produce|generate|launch|set up|new|revamp|from scratch)\b/i;
const REFINEMENT = /\b(?:polish|improve|refresh|fix|tweak|adjust|clean up|tidy)\b/i;
/** Only explicit look/style comparisons create style references. */
const STYLE_REFERENCE = /\b(?:(?:look|feel|style|design|theme)s?\s+(?:like|similar to)|(?:same|similar)\s+(?:style|look|design|theme|feel|aesthetic)\s+(?:as|to)|inspired by|in the style of|match(?:ing)?\s+(?:the\s+)?(?:style|look|design|theme)\s+of|based on the design of)\s+([^\s,;!?)]+)/gi;
/** Concrete style specifics mean the user already decided the direction. */
const STYLE_SPECIFIC = /#[0-9a-f]{3,8}\b|\b(?:font|typeface|palette|colou?rs?)\s*(?::|=|should be|must be)|\b(?:figma|wireframe|mockup attached|design file|brand guide(?:lines)?)\b|\b(?:use|keep|follow|match)\s+(?:our|the existing|the current)\s+(?:design|brand|style|theme|tokens)/i;
const URLISH = /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|ai|co|name|xyz|site|online|space|me|info|design|studio)(?:\/[^\s)]*)?/gi;

const clean = (value: string) => value.replace(/[\s"'`)\].]+$/g, "").replace(/^https?:\/\//i, "").replace(/\/$/, "").slice(0, 80);

/** Deterministic reading, used alone when the model analysis is unavailable. */
export function heuristicDesignBrief(prompt: string): DesignBrief | undefined {
	if (typeof prompt !== "string" || !prompt.trim()) return undefined;
	const text = prompt.slice(0, 32_000);
	const newWork = NEW_WORK.test(text);
	const visualDesign = VISUAL_SUBJECT.test(text) && (newWork || REFINEMENT.test(text));
	if (!visualDesign) return undefined;
	const styleReferences = [...new Set([...text.matchAll(STYLE_REFERENCE)].map((match) => clean(match[1] ?? "")).filter(Boolean))].slice(0, 4);
	const styleKeys = new Set(styleReferences.map((ref) => ref.toLowerCase()));
	const contextReferences = [...new Set([...text.matchAll(URLISH)].map((match) => clean(match[0])))]
		.filter((ref) => ref && ![...styleKeys].some((style) => ref.toLowerCase().includes(style) || style.includes(ref.toLowerCase())))
		.slice(0, 6);
	return { visualDesign, openEnded: newWork && !styleReferences.length && !STYLE_SPECIFIC.test(text), styleReferences, contextReferences, source: "heuristic" };
}

/** Model flags take precedence; the heuristic fills gaps so a failed or terse
 * analysis cannot silently drop the protocol for an obviously visual brief. */
export function detectDesignBrief(prompt: string, analysis?: Pick<PromptAnalysis, "source" | "openEnded" | "visualDesign" | "styleReferences" | "contextReferences">): DesignBrief | undefined {
	const heuristic = heuristicDesignBrief(prompt);
	if (analysis?.source !== "model") return heuristic;
	const visualDesign = analysis.visualDesign === true || Boolean(heuristic?.visualDesign);
	const openEnded = analysis.openEnded === true || (analysis.openEnded === undefined && Boolean(heuristic?.openEnded));
	if (!visualDesign && !openEnded) return undefined;
	const styleReferences = [...new Set([...(analysis.styleReferences ?? []), ...(heuristic?.styleReferences ?? [])])].slice(0, 4);
	const contextReferences = [...new Set([...(analysis.contextReferences ?? []), ...(heuristic?.contextReferences ?? [])])]
		.filter((ref) => !styleReferences.includes(ref)).slice(0, 6);
	return { visualDesign, openEnded, styleReferences, contextReferences, source: "analysis" };
}

/** Bounded guidance for the main agent. Returns "" when nothing applies. */
/** The post-edit UI signals in slop-guidance-signals.ts, condensed for delivery before a visual
 * direction is chosen: checking them after the redesign is locked in costs a
 * second pass over finished work. Keep in step with the signal checks and
 * UI_DESIGN_POLICY (the review-time form of the same constraints). */
export const UI_PREFLIGHT_TELLS: readonly string[] = [
  "glowing dot markers before labels or chips",
  "colored left rails on cards",
  "icons inside tinted tiles",
  "the indigo-to-purple gradient palette or muddy orange/brass/brown default accents",
  "generic lightbulb branding",
  "ad hoc hard-coded hues instead of a small token set",
  "suppressed focus outlines without a visible replacement",
  "content pinned with absolute coordinates",
  "centered body copy",
  "continuous decorative motion without reduced-motion handling",
  "pill capsules for ordinary labels (pills mean selection, state or tags)",
  "hype badges (NEW, BETA, AI, FAST) without meaningful state",
  "gradient-filled headline text",
  "glassmorphism panels without a floating layer",
  "display type at 80px or larger for ordinary pages",
  "emoji in headings, buttons or navigation",
  "decorative terminal output or pseudo-telemetry",
  "images without alt text and icon-only buttons without names",
];

export function designDirectionGuidance(brief: DesignBrief | undefined): string {
	if (!brief || (!brief.openEnded && !brief.contextReferences.length && !brief.visualDesign)) return "";
	const lines = ["Harness design-direction guidance (advisory; the user's words and project conventions win):"];
	if (brief.openEnded) {
		lines.push(brief.visualDesign
			? "- This brief leaves the design to you. Before building, run a short divergence pass instead of taking the first obvious look: state audience, purpose and the brand's own character in one line each; study 3–5 strong peers in this domain for patterns and gaps (never clone one); sketch 3 genuinely distinct directions (concept, layout rhythm, type pairing, palette, motion, one signature element); choose with explicit criteria (fit to the brief and brand, distinctiveness, accessibility, feasibility) — a council is appropriate when directions are close; record the chosen direction and why in the plan, then build and verify it rendered."
			: "- This request leaves major decisions to you. Before committing, run a brief thought experiment: list 2–3 materially different approaches, weigh them against the stated constraints and likely user intent, and record why the chosen one wins. Prefer the approach a demanding expert would pick, not merely the easiest.");
	}
	if (brief.contextReferences.length) lines.push(`- Context-only references: ${brief.contextReferences.map((ref) => JSON.stringify(ref)).join(", ")}. Use them for what the user named (links, credit, deployment, conventions); they are not design sources — do not borrow their fonts, palette, layout or copy${brief.visualDesign ? "; the new work needs its own identity" : ""}.`);
	if (brief.visualDesign) lines.push(`- Decide against these generated-UI tells while choosing the direction, not after building it: ${UI_PREFLIGHT_TELLS.join("; ")}.`);
	if (brief.styleReferences.length) lines.push(`- Explicit style references: ${brief.styleReferences.map((ref) => JSON.stringify(ref)).join(", ")}. Learn their principles; do not copy them wholesale.`);
	return lines.join("\n").slice(0, 2000);
}

/** One TUI line describing what the guidance told the agent. */
export function designDirectionSummary(brief: DesignBrief | undefined): string {
	if (!designDirectionGuidance(brief)) return "";
	const parts = [brief!.openEnded ? (brief!.visualDesign ? "open visual brief → explore distinct directions before building" : "open brief → weigh alternative approaches first") : brief!.visualDesign ? "visual work → UI tells checked before building" : "references classified"];
	if (brief!.contextReferences.length) parts.push(`context-only: ${brief!.contextReferences.slice(0, 3).join(", ")}`);
	if (brief!.styleReferences.length) parts.push(`style refs: ${brief!.styleReferences.slice(0, 2).join(", ")}`);
	return `Design direction: ${parts.join(" · ")}.`;
}
