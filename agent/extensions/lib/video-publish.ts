/** Publishing side of code-first video: where calls to action go, chapters,
 * a description draft and readiness findings for a video meant for an
 * audience. Pure functions over video.json and the derived scene times; a
 * video whose intent is "personal" gets none of it. */
import type { Issue, TimedScene } from "./video-studio.ts";

export type Moment = { at: number; seconds?: number; prompt?: string };
export type Cta = { enabled?: boolean; like?: Moment | null; follow?: Moment | null; comment?: Moment | null; share?: Moment | null };

export const PLATFORMS = ["youtube", "shorts", "tiktok", "instagram", "x", "linkedin", "facebook"] as const;
/** Platforms whose feed is full-screen vertical video. */
const VERTICAL = new Set(["shorts", "tiktok", "instagram"]);
export const isPublishing = (spec: any) => spec?.publish?.intent !== "personal";

const stamp = (seconds: number) => {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
};

/** Place like / follow / comment moments where an ask is earned: after the
 * viewer has had value, at a scene boundary (a fresh idea, not mid-sentence),
 * and clear of the end screen. Short videos get a single follow ask. Hand-set
 * moments are kept. `commentPrompt` is the author's own question; without one
 * no comment ask is made. */
export function planCtas(scenes: TimedScene[], seconds: number, existing: Cta = {}, options: { commentPrompt?: string; sharePrompt?: string } = {}): Cta {
  const out: Cta = { ...existing, enabled: true };
  const outro = scenes.find((scene) => scene.component === "OutroScene");
  const limit = (outro?.start ?? seconds) - 5;
  const boundary = (from: number, to: number) => scenes.slice(1).find((scene) => scene.start >= from && scene.start <= to && scene.start + 4 <= limit);
  const at = (scene: TimedScene | undefined) => scene ? Number((scene.start + 0.6).toFixed(2)) : undefined;
  if (seconds < 20) return { ...out, like: existing.like ?? null, follow: existing.follow ?? null };
  if (existing.like === undefined) { const t = at(boundary(Math.max(15, seconds * 0.22), seconds * 0.5)); out.like = t === undefined || seconds < 40 ? null : { at: t }; }
  if (existing.follow === undefined) { const t = at(boundary(Math.max(25, seconds * 0.55), seconds * 0.85)) ?? (outro ? undefined : Number(Math.max(8, limit - 6).toFixed(2))); out.follow = t === undefined || (outro && seconds < 40) ? null : { at: t }; }
  if (existing.comment === undefined) { const t = at(boundary(seconds * 0.7, seconds * 0.92)); out.comment = options.commentPrompt && t !== undefined && seconds >= 60 ? { at: t, prompt: options.commentPrompt } : null; }
  if (existing.share === undefined) out.share = null;
  return out;
}

/** YouTube chapters: the first must be 0:00 and there must be at least three, each ten seconds or longer. */
export function chapterList(scenes: TimedScene[]): Array<{ start: number; title: string }> {
  const marked = scenes.map((scene: any) => ({ start: scene.start, title: typeof scene.chapter === "string" ? scene.chapter.trim() : "" })).filter((c) => c.title);
  if (marked.length && marked[0].start > 0.01) marked.unshift({ start: 0, title: marked[0].title === "Intro" ? "Start" : "Intro" });
  return marked;
}
export const formatChapters = (chapters: Array<{ start: number; title: string }>) => chapters.map((c) => `${stamp(c.start)} ${c.title}`).join("\n");

/** A description skeleton: the author still writes the hook line and links. */
export function descriptionDraft(spec: any, chapters: Array<{ start: number; title: string }>): string {
  const brand = spec?.brand ?? {};
  const credits: string[] = spec?.publish?.credits ?? [];
  return [
    `${spec?.title ?? "Untitled"}`,
    "",
    "<One or two sentences that say what the viewer gets and why it matters. The first 150 characters show in search and the feed.>",
    ...(chapters.length ? ["", "Chapters", formatChapters(chapters)] : []),
    ...(brand.website || brand.handle ? ["", [brand.name, brand.handle, brand.website].filter(Boolean).join(" · ")] : []),
    ...(credits.length ? ["", "Credits", ...credits] : []),
  ].join("\n") + "\n";
}

/** Findings that only matter when the video is meant for an audience. */
export function publishFindings(spec: any, scenes: TimedScene[], seconds: number): Issue[] {
  if (!isPublishing(spec)) return [{ severity: "info", message: "Intent is personal: brand mark, calls to action, end screen and cover are not required." }];
  const issues: Issue[] = [];
  const warn = (message: string, scene?: string) => issues.push({ severity: "warn", message, ...(scene ? { scene } : {}) });
  const platforms: string[] = spec?.publish?.platforms ?? ["youtube"];
  const first: any = scenes[0];
  const portrait = spec.height > spec.width;
  if (first) {
    if ((first.narrationOffset ?? 0) > 1 && first.narration) warn(`Narration starts ${first.narrationOffset}s in; viewers decide in the first seconds, so speak (or show the payoff) within one second.`, first.id);
    if (seconds > 30 && /title/i.test(first.component) && first.seconds > 6) warn(`The opening is a ${first.seconds}s title card. Open with the question, the payoff or the strangest fact, and let the title arrive with it.`, first.id);
  }
  const body = scenes.filter((scene) => scene.component !== "OutroScene");
  for (const scene of body) if (scene.seconds > 14 && Object.keys(scene.cues ?? {}).length < 2) warn(`${scene.seconds.toFixed(0)}s with fewer than two cues reads as a still image; add a visual change at least every 5-8 s.`, scene.id);
  if (body.length >= 3 && seconds / body.length > 12) warn(`Average scene length is ${(seconds / body.length).toFixed(1)}s; retention holds better with a change of image or idea every 5-10 s.`);
  if (spec.captions?.enabled !== true) warn("Captions are off; most feeds autoplay muted, and captions also feed search. Enable video.json captions.");
  if (platforms.some((p) => VERTICAL.has(p)) && !portrait) warn(`Platform ${platforms.filter((p) => VERTICAL.has(p)).join("/")} is a vertical feed; use format "vertical" (1080x1920) and keep it under 60 s.`);
  if (platforms.includes("youtube") && portrait && seconds > 180) warn("A vertical video over 3 minutes will not play as a Short; make it landscape or cut it.");
  if (platforms.some((p) => VERTICAL.has(p)) && seconds > 60) warn(`${seconds.toFixed(0)}s is long for a vertical feed; under 60 s keeps completion high.`);
  const cta: Cta | undefined = spec.publish?.cta;
  const named = Boolean(spec.brand?.name || spec.brand?.handle);
  const moments = (["like", "follow", "comment", "share"] as const).flatMap((kind) => cta?.[kind] ? [[kind, cta[kind]!] as const] : []);
  for (const [kind, moment] of moments) {
    if (moment.at < 8) warn(`The ${kind} ask at ${moment.at}s comes before the viewer has had any value; place it after the first payoff.`);
    if (moment.at >= seconds) warn(`The ${kind} ask at ${moment.at}s is outside the timeline.`);
  }
  if (named && seconds >= 45 && cta?.enabled !== false && !moments.length) warn('A brand is named but no like/follow moments are placed; run video_project action:"cta" once the timeline is final (or set publish.cta.enabled to false).');
  if (named && seconds >= 45 && !scenes.some((scene) => scene.component === "OutroScene")) warn("A brand is named but the video has no end screen; add an OutroScene of 8-15 s (platforms overlay their own end-screen elements there).");
  const chapters = chapterList(scenes);
  if (platforms.includes("youtube") && !portrait && seconds >= 180) {
    if (chapters.length < 3) warn("Videos of 3+ minutes earn chapters in search and the player; mark at least three scenes with a chapter title (first at 0:00, each 10 s or longer).");
    else if (chapters.some((c, i) => i < chapters.length - 1 && chapters[i + 1].start - c.start < 10)) warn("A chapter is shorter than 10 s; YouTube ignores chapter lists with sections that short.");
  }
  if (platforms.includes("youtube") && !portrait && !spec.publish?.thumbnail) warn('No cover is set; add publish.thumbnail {text, image?} and render it with video_render mode "thumbnail". Text is what survives a phone-sized thumbnail: three or four words.');
  const words = String(spec.publish?.thumbnail?.text ?? "").replace(/\*/g, "").split(/\s+/).filter(Boolean).length;
  if (words > 5) warn(`Thumbnail text has ${words} words; three or four survive a phone-sized cover.`);
  return issues;
}

/** Validate the brand/publish blocks of video.json (structure only). */
export function validatePublishSpec(spec: any, seconds: number): Issue[] {
  const issues: Issue[] = [];
  const err = (message: string) => issues.push({ severity: "error", message });
  if (spec.brand !== undefined) {
    if (!spec.brand || typeof spec.brand !== "object") err("brand must be an object");
    else for (const key of ["name", "handle", "website", "tagline", "logo"]) if (spec.brand[key] !== undefined && (typeof spec.brand[key] !== "string" || spec.brand[key].length > 120)) err(`brand.${key} must be a string of at most 120 characters`);
  }
  const publish = spec.publish;
  if (publish === undefined) return issues;
  if (!publish || typeof publish !== "object" || !["publish", "personal"].includes(publish.intent)) { err('publish.intent must be "publish" or "personal"'); return issues; }
  if (publish.platforms !== undefined && (!Array.isArray(publish.platforms) || !publish.platforms.length || publish.platforms.some((p: unknown) => !(PLATFORMS as readonly string[]).includes(p as string)))) err(`publish.platforms must list ${PLATFORMS.join(", ")}`);
  for (const kind of ["like", "follow", "comment", "share"]) {
    const moment = publish.cta?.[kind];
    if (moment === undefined || moment === null) continue;
    if (typeof moment.at !== "number" || moment.at < 0 || moment.at >= seconds) err(`publish.cta.${kind}.at must be inside the timeline (0..${seconds.toFixed(1)}s)`);
    if (moment.seconds !== undefined && (typeof moment.seconds !== "number" || moment.seconds < 1 || moment.seconds > 10)) err(`publish.cta.${kind}.seconds must be 1..10`);
  }
  if (publish.thumbnail !== undefined && (typeof publish.thumbnail?.text !== "string" || !publish.thumbnail.text.trim())) err("publish.thumbnail.text is required");
  return issues;
}
