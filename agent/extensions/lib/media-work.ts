/**
 * Media work: requests and files that belong to a picture-and-sound pipeline
 * (a film, a video, a render, a 3D scene), not to an interface.
 *
 * WHY: film work speaks interface vocabulary ("typography", "a calm palette",
 * "transitions", "a logo reveal component") and writes interface file types
 * (Remotion acts are .tsx, HtmlScene pages are .html). Triggers that read those
 * cues injected UI-design doctrine, UI hints and frontend guidance into video
 * sessions. Each such trigger asks this module first. A request that also names
 * a real interface surface (a website, a page, a dashboard, a screen, a video
 * player) is not media work, so interface guidance still reaches it. Pure.
 */
const MEDIA_PROMPT = /\b(?:videos?|films?|movies?|trailers?|teasers?|stings?|reels?|footage|mp4|webm|storyboard\w*|narrat\w*|voice-?overs?|soundtracks?|motion[- ]graphics?|motion[- ]design|kinetic (?:type|typography)|title sequences?|remotion|hyperframes|blender|renders?|rendering|3d (?:scenes?|models?|animations?|figures?)|cutaways?|exploded[- ]views?|turntables?|(?:motion|video) ads?|logo (?:reveals?|stings?|intros?|animations?)|intro (?:animations?|sequences?))\b/i;
const UI_SURFACE = /\b(?:ui|ux|gui|user interfaces?|front-?end|web ?sites?|web ?pages?|landing ?pages?|home ?pages?|web ?apps?|dashboards?|screens?|forms?|nav ?bars?|side ?bars?|modals?|buttons?|storefronts?|portfolio sites?|settings (?:pages?|panels?)|(?:video|media|audio) players?|css|tailwind)\b/i;
/** Video project folders: cinetic acts, video_project HTML scenes, shot renders and film workspaces. */
const MEDIA_PATH = /(?:^|\/)(?:films?|videos?|remotion|hyperframes|shots|public\/html|src\/acts)\//i;
/** Remotion and HyperFrames sources, and HtmlScene pages fed by the video timeline. */
const MEDIA_CONTENT = /from\s+['"](?:remotion|@remotion\/[\w-]+)['"]|\buseCurrentFrame\s*\(|\bdata-composition-id\b|window\.__PROPS__/;

/** A preset front or the verification line: harness wording, e.g. Noslop's "UI and visual slop gone". */
const HARNESS_CRITERION = /^\s*-\s*(?:V:|C\d+:\s*(?:3D|Video|Noslop|Nobug|Anatomy)\b[^:\n]{0,30}:)/i;

/**
 * The user's request inside a goal turn. A kickoff or continuation carries the harness's own briefs and preset
 * fronts, which name interface surfaces for every goal; judged whole, a film goal with /noslop read as UI work
 * and its continuations were handed UI doctrine. Keep the user's words and their own criteria only.
 */
export function goalRequestText(prompt: string): string {
	if (!/^\[goal(?:-tracked)? \w+/.test(prompt)) return prompt;
	const words = /The user wrote: «([\s\S]*?)»/.exec(prompt)?.[1] ?? /^\[goal-tracked \w+\] Goal: ([^\n]*)/.exec(prompt)?.[1] ?? "";
	const own = (prompt.match(/^\s*-\s*(?:C\d+|V):[^\n]*$/gm) ?? []).filter((line) => !HARNESS_CRITERION.test(line));
	return [words, ...own].join("\n");
}

/** The request is film, video or render work and names no interface surface. */
export function mediaWork(prompt: string): boolean {
	const text = typeof prompt === "string" ? goalRequestText(prompt.slice(0, 20000)).slice(0, 6000) : "";
	return MEDIA_PROMPT.test(text) && !UI_SURFACE.test(text);
}

/** The file belongs to a video project by its folder or its content. */
export function mediaFile(file: string, content?: string): boolean {
	const normalized = String(file ?? "").replaceAll("\\", "/");
	return MEDIA_PATH.test(normalized) || (typeof content === "string" && MEDIA_CONTENT.test(content.slice(0, 24000)));
}
