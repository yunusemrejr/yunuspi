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
 *
 * AMBITION: the same prompt discipline that keeps a dashboard calm also kept a
 * "stunning, cinematic, 3D" brief from ever reaching the ambitious end: every
 * count cap in the UI doctrine (one flourish, one effect per screen) is right
 * for quiet work and wrong for an experience. The brief therefore carries an
 * ambition level read from the prompt and its subject, and the guidance says
 * what that level permits (the signature-experience skill owns how to build it).
 */
import type { PromptAnalysis } from "./prompt-interpretation.ts";

/** How much expression a brief and its subject call for. */
export type Ambition = "restrained" | "balanced" | "immersive";

export interface DesignBrief {
	visualDesign: boolean;
	openEnded: boolean;
	/** Set whenever the brief is visual; see heuristicAmbition. */
	ambition?: Ambition;
	styleReferences: string[];
	contextReferences: string[];
	source: "analysis" | "heuristic";
}

const VISUAL_SUBJECT = /\b(?:web ?sites?|landing ?pages?|home ?pages?|web ?apps?|front[- ]?end|user interfaces?|ui|ux|interfaces?|dashboards?|screens?|layouts?|themes?|logos?|brand(?:ing)?|visual identity|posters?|banners?|mockups?|illustrations?|animations?|motion graphics|slides?|decks?|icons?|typography|color palettes?|design systems?|portfolio|storefront|blog|gui|(?:mobile|desktop|native) apps?|games?|look and feel|visuals?)\b/i;
/** New work leaves the direction open; refinement keeps the existing language. */
const NEW_WORK = /\b(?:create|build|make|design|redesign|restyle|develop|craft|produce|generate|launch|set up|new|revamp|from scratch)\b/i;
const REFINEMENT = /\b(?:polish|improve|refresh|fix|tweak|adjust|clean up|tidy)\b/i;
/** Only explicit look/style comparisons create style references. */
const STYLE_REFERENCE = /\b(?:(?:look|feel|style|design|theme)s?\s+(?:like|similar to)|(?:same|similar)\s+(?:style|look|design|theme|feel|aesthetic)\s+(?:as|to)|inspired by|in the style of|match(?:ing)?\s+(?:the\s+)?(?:style|look|design|theme)\s+of|based on the design of)\s+([^\s,;!?)]+)/gi;
/** Concrete style specifics mean the user already decided the direction. */
const STYLE_SPECIFIC = /#[0-9a-f]{3,8}\b|\b(?:font|typeface|palette|colou?rs?)\s*(?::|=|should be|must be)|\b(?:figma|wireframe|mockup attached|design file|brand guide(?:lines)?)\b|\b(?:use|keep|follow|match)\s+(?:our|the existing|the current)\s+(?:design|brand|style|theme|tokens)/i;
const URLISH = /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|ai|co|name|xyz|site|online|space|me|info|design|studio)(?:\/[^\s)]*)?/gi;

const clean = (value: string) => value.replace(/[\s"'`)\].]+$/g, "").replace(/^https?:\/\//i, "").replace(/\/$/, "").slice(0, 80);

/** An explicit ask for spectacle: motion, 3D or an experience. */
const SPECTACLE_CUES = /\b(?:cinematic|immersive|3d|three\.?js|webgl|shaders?|particles?|parallax|motion graphics|scroll[- ]?(?:driven|telling|animat\w+)|advanced (?:motion|animations?|graphics|effects?|visuals?)|game[- ]?like|interactive (?:hero|world|scene|experience|simulation|model)|mascot|living|alive)\b/gi;
/** An ask for impressiveness; whether that means spectacle depends on the subject. */
const QUALITY_CUES = /\b(?:stunning|breathtaking|jaw[- ]?dropping|awwwards?|show-?stopp(?:er|ing)|wow(?: factor)?|sota|state[- ]of[- ]the[- ]art|next[- ]level|world[- ]class|flagship|playful|delightful)\b/gi;
const RESTRAINED_CUES = /\b(?:minimal(?:ist|ism)?|clean|simple|calm|quiet|understated|sober|plain|dense|data[- ]?(?:dense|heavy)|lightweight|text[- ]first|performance[- ]first)\b/gi;
const NO_MOTION = /\b(?:no|without|avoid|skip|zero)\s+(?:any\s+|unnecessary\s+)?(?:animations?|motion|effects?|3d|webgl)\b/i;
/** Work whose job is to be used, not looked at. */
const FUNCTIONAL_SUBJECT = /\b(?:dashboards?|admin(?: panel)?|settings|forms?|tables?|crud|back[- ]?office|internal tools?|control panel|inventory|ledger|calculator|editor|mail(?:ing)? app|inbox)\b/i;

/** Expression level a brief calls for, read from its words and subject. Pure, deterministic and advisory.
 * Spectacle cues ask for it outright; quality cues ("stunning") mean spectacle for a site that is looked at
 * and craft for one that is used; restraint cues or "no animations" win over both when nothing else asks. */
export function heuristicAmbition(prompt: string): Ambition {
	const text = String(prompt ?? "").slice(0, 32_000);
	if (NO_MOTION.test(text)) return "restrained";
	const spectacle = (text.match(SPECTACLE_CUES) ?? []).length;
	const quality = (text.match(QUALITY_CUES) ?? []).length;
	const restrained = (text.match(RESTRAINED_CUES) ?? []).length;
	const functional = FUNCTIONAL_SUBJECT.test(text);
	if (spectacle) return restrained > spectacle ? "balanced" : "immersive";
	if (quality) return restrained ? "balanced" : functional ? "balanced" : "immersive";
	if (restrained) return "restrained";
	return functional ? "restrained" : "balanced";
}

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
	return { visualDesign, openEnded: newWork && !styleReferences.length && !STYLE_SPECIFIC.test(text), ambition: heuristicAmbition(text), styleReferences, contextReferences, source: "heuristic" };
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
	return { visualDesign, openEnded, ...(visualDesign ? { ambition: heuristic?.ambition ?? heuristicAmbition(prompt) } : {}), styleReferences, contextReferences, source: "analysis" };
}

/** The post-edit UI signals in slop-guidance-signals.ts, condensed for delivery before a visual
 * direction is chosen: checking them after the redesign is locked in costs a
 * second pass over finished work. Keep in step with the signal checks and
 * UI_DESIGN_POLICY (the review-time form of the same constraints). */
export const UI_PREFLIGHT_TELLS: readonly string[] = [
  "glowing dot markers before labels or chips",
  "colored left rails on cards",
  "icons inside tinted tiles",
  "the indigo-to-purple gradient palette, the cream-and-terracotta editorial look with an oversized italic serif, or muddy orange/brass/brown default accents",
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
  "blurred colour blobs and glow halos",
  "display type at 80px or larger for ordinary pages",
  "emoji in headings, buttons or navigation",
  "decorative terminal output or pseudo-telemetry",
  "images without alt text and icon-only buttons without names",
  "invented stats, logos or testimonials",
];

/** What each expression level permits. The immersive line is the one the count caps elsewhere in the UI doctrine
 * would otherwise veto, so it says outright that they stop applying and what replaces them. */
const AMBITION_GUIDANCE: Record<Ambition, string> = {
	restrained: "- Ambition: restrained. Quiet craft: one clear idea, exact type and spacing, motion only where it explains state; keep the finite-set budget in frontend-design.",
	balanced: "- Ambition: balanced. One signature element carries the identity (a distinctive illustration, a live model of the product, a hero motion); everything around it stays quiet, finite and fast.",
	immersive: "- Ambition: immersive. The brief asks for an experience, so aim at a signature world, not a themed template (read signature-experience): derive it from the subject's own world, not from a trend; ship a static baseline first, then layer ambient life, interaction and scroll choreography; give every layer a fallback (reduced motion, no WebGL, phone) and keep performance and accessibility as the budgets. The count caps in frontend-design and web-effects stop applying here; coherence replaces them.",
};

/** Bounded guidance for the main agent. Returns "" when nothing applies. */
export function designDirectionGuidance(brief: DesignBrief | undefined): string {
	if (!brief || (!brief.openEnded && !brief.contextReferences.length && !brief.visualDesign)) return "";
	const lines = ["Harness design-direction guidance (advisory; the user's words and project conventions win):"];
	if (brief.openEnded) {
		lines.push(brief.visualDesign
			? "- This brief leaves the design to you. Before building, run a short divergence pass instead of taking the first obvious look: state audience, purpose and the subject's own character in one line each; study 3–5 strong peers for patterns and gaps (never clone one); sketch 3 genuinely distinct directions (concept, layout rhythm, type pairing, palette, motion, one signature element); choose by fit to the brief, distinctiveness, accessibility and feasibility (a council when they are close); record the choice and why with creative_direct set (include ambition and signature) and in the plan, then build and verify it rendered."
			: "- This request leaves major decisions to you. Before committing, run a brief thought experiment: list 2–3 materially different approaches, weigh them against the stated constraints and likely user intent, and record why the chosen one wins. Prefer the approach a demanding expert would pick, not merely the easiest.");
	}
	if (brief.visualDesign && brief.ambition) lines.push(AMBITION_GUIDANCE[brief.ambition]);
	if (brief.contextReferences.length) lines.push(`- Context-only references: ${brief.contextReferences.map((ref) => JSON.stringify(ref)).join(", ")}. Use them for what the user named (links, credit, deployment, conventions); they are not design sources — do not borrow their fonts, palette, layout or copy${brief.visualDesign ? "; the new work needs its own identity" : ""}.`);
	if (brief.visualDesign) lines.push(`- Decide against these generated-UI tells while choosing the direction, not after building it (the design-slop-prevention skill explains why and gives the swap test): ${UI_PREFLIGHT_TELLS.join("; ")}.`);
	if (brief.styleReferences.length) lines.push(`- Explicit style references: ${brief.styleReferences.map((ref) => JSON.stringify(ref)).join(", ")}. Learn their principles; do not copy them wholesale.`);
	return lines.join("\n").slice(0, DESIGN_GUIDANCE_CAP);
}

/** The full tell list, an immersive brief and several context references must all fit: a cut drops the last tells. */
export const DESIGN_GUIDANCE_CAP = 3000;

/** One TUI line describing what the guidance told the agent. */
export function designDirectionSummary(brief: DesignBrief | undefined): string {
	if (!designDirectionGuidance(brief)) return "";
	const parts = [brief!.openEnded ? (brief!.visualDesign ? "open visual brief → explore distinct directions before building" : "open brief → weigh alternative approaches first") : brief!.visualDesign ? "visual work → UI tells checked before building" : "references classified"];
	if (brief!.visualDesign && brief!.ambition) parts.push(`ambition ${brief!.ambition}`);
	if (brief!.contextReferences.length) parts.push(`context-only: ${brief!.contextReferences.slice(0, 3).join(", ")}`);
	if (brief!.styleReferences.length) parts.push(`style refs: ${brief!.styleReferences.slice(0, 2).join(", ")}`);
	return `Design direction: ${parts.join(" · ")}.`;
}
