/** Art direction for code-first video: curated looks (palette, type, backdrop,
 * caption style and the voice/music that belong with them), a font catalog
 * pinned to @fontsource, and a linter for the defaults that make generated
 * video read as machine-made. Pure: no I/O, so init, check and tests share it. */

export type FontChoice = { package: string; family: string; weights: number[] };
export type LookTheme = {
  background: string; surface: string; ink: string; muted: string; accent: string; accent2: string; danger: string;
  display: string; text: string; mono: string;
  backdrop: "lattice" | "rules" | "halftone" | "contour" | "none";
  /** Display face weight/tracking: heavy grotesques want tight tracking, serifs none. */
  displayWeight: number; displayTracking: number;
  caption: "solid" | "outline" | "plain";
};
export type Look = {
  id: string; name: string; tone: "dark" | "light";
  /** Subjects and audiences this look is derived from; pick by subject, not by taste. */
  fits: string;
  /** One line on why the neutrals and accents have this hue (design doctrine step 3). */
  why: string;
  theme: LookTheme;
  fonts: FontChoice[];
  audio: { music: { style: string; bpm: number; key: string; mode: "major" | "minor" | "dorian" }; voice: { voice: string; style: string } };
};

const plexMono: FontChoice = { package: "ibm-plex-mono", family: "IBM Plex Mono", weights: [400, 500] };

export const LOOKS: Look[] = [
  { id: "paper-lab", name: "Paper Lab", tone: "light",
    fits: "science, engineering and how-things-work explainers watched in daylight, on phones and in classrooms",
    why: "Neutrals lean cool blue-gray so vermilion and cobalt read as ink marks on lab paper; no warm cream.",
    theme: { background: "#E7ECF0", surface: "#F5F8FA", ink: "#0D1922", muted: "#41535F", accent: "#C8321A", accent2: "#1F4FD1", danger: "#A8231B", display: "Bricolage Grotesque", text: "Hanken Grotesk", mono: "IBM Plex Mono", backdrop: "rules", displayWeight: 800, displayTracking: -0.025, caption: "solid" },
    fonts: [{ package: "bricolage-grotesque", family: "Bricolage Grotesque", weights: [700, 800] }, { package: "hanken-grotesk", family: "Hanken Grotesk", weights: [400, 600, 700] }, plexMono],
    audio: { music: { style: "curious", bpm: 96, key: "G", mode: "major" }, voice: { voice: "en_US-ryan-high", style: "documentary" } } },
  { id: "carbon-signal", name: "Carbon Signal", tone: "dark",
    fits: "software, machine learning, systems and hardware topics for a technical audience that watches at night",
    why: "Carbon neutral with a faint warm bias keeps amber (a lit indicator) from vibrating against a cold blue-black.",
    theme: { background: "#121211", surface: "#1D1E1C", ink: "#EEF0EC", muted: "#9CA39C", accent: "#FFB000", accent2: "#5CC8FF", danger: "#FF5C5C", display: "Schibsted Grotesk", text: "Albert Sans", mono: "IBM Plex Mono", backdrop: "lattice", displayWeight: 800, displayTracking: -0.02, caption: "solid" },
    fonts: [{ package: "schibsted-grotesk", family: "Schibsted Grotesk", weights: [700, 800] }, { package: "albert-sans", family: "Albert Sans", weights: [400, 600, 700] }, plexMono],
    audio: { music: { style: "focused", bpm: 92, key: "D", mode: "dorian" }, voice: { voice: "en_US-ryan-high", style: "documentary" } } },
  { id: "press-room", name: "Press Room", tone: "dark",
    fits: "investigations, industry and infrastructure stories, opinion and commentary that need weight and urgency",
    why: "A warm black like newsprint ink lets a single chartreuse highlighter mark the claim under discussion.",
    theme: { background: "#141110", surface: "#211D1B", ink: "#F2EFE9", muted: "#A79F95", accent: "#D4F04C", accent2: "#FF6A3D", danger: "#FF5D5D", display: "Big Shoulders Display", text: "Work Sans", mono: "DM Mono", backdrop: "halftone", displayWeight: 800, displayTracking: 0, caption: "solid" },
    fonts: [{ package: "big-shoulders-display", family: "Big Shoulders Display", weights: [700, 800] }, { package: "work-sans", family: "Work Sans", weights: [400, 600, 700] }, { package: "dm-mono", family: "DM Mono", weights: [400, 500] }],
    audio: { music: { style: "driving", bpm: 104, key: "A", mode: "minor" }, voice: { voice: "en_GB-alan-medium", style: "documentary" } } },
  { id: "archive-brass", name: "Archive Brass", tone: "dark",
    fits: "history, biography, culture and long-form documentary where a serif voice belongs to the subject",
    why: "Umber-black and brass echo the archive: aged metal and lamplight, with verdigris as the counter-color.",
    theme: { background: "#19130F", surface: "#261E18", ink: "#F0EBE1", muted: "#AB9F8E", accent: "#DDA63A", accent2: "#7DB5A9", danger: "#E4675A", display: "Newsreader", text: "Public Sans", mono: "IBM Plex Mono", backdrop: "contour", displayWeight: 700, displayTracking: -0.01, caption: "plain" },
    fonts: [{ package: "newsreader", family: "Newsreader", weights: [600, 700] }, { package: "public-sans", family: "Public Sans", weights: [400, 600, 700] }, plexMono],
    audio: { music: { style: "reflective", bpm: 72, key: "D", mode: "minor" }, voice: { voice: "en_GB-alan-medium", style: "calm" } } },
  { id: "sunrise-kinetic", name: "Sunrise Kinetic", tone: "light",
    fits: "short-form, consumer how-tos, tips, product news and anything that must stop a thumb mid-scroll",
    why: "Saturated signal yellow with true black ink gives maximum figure/ground contrast at thumbnail size; red and blue are the print-shop spot colors.",
    theme: { background: "#FFD84A", surface: "#FFEB94", ink: "#15120A", muted: "#4A3F0C", accent: "#D9281A", accent2: "#0F3FD9", danger: "#B01F14", display: "Archivo Black", text: "Archivo", mono: "IBM Plex Mono", backdrop: "halftone", displayWeight: 400, displayTracking: -0.02, caption: "outline" },
    fonts: [{ package: "archivo-black", family: "Archivo Black", weights: [400] }, { package: "archivo", family: "Archivo", weights: [500, 700] }, plexMono],
    audio: { music: { style: "upbeat", bpm: 118, key: "C", mode: "major" }, voice: { voice: "en_US-ryan-high", style: "energetic" } } },
  { id: "ledger-green", name: "Ledger Green", tone: "light",
    fits: "money, business, economics, markets and data-driven explainers that must feel trustworthy",
    why: "A cool paper-white with a deep banknote green (not corporate blue) and amber for the number under scrutiny.",
    theme: { background: "#F2F5F7", surface: "#FFFFFF", ink: "#0C1B2E", muted: "#465868", accent: "#0A6B4B", accent2: "#A65F00", danger: "#C2302B", display: "Chivo", text: "Public Sans", mono: "IBM Plex Mono", backdrop: "rules", displayWeight: 800, displayTracking: -0.02, caption: "solid" },
    fonts: [{ package: "chivo", family: "Chivo", weights: [700, 800] }, { package: "public-sans", family: "Public Sans", weights: [400, 600, 700] }, plexMono],
    audio: { music: { style: "confident", bpm: 100, key: "F", mode: "major" }, voice: { voice: "en_US-ryan-high", style: "documentary" } } },
  { id: "field-notes", name: "Field Notes", tone: "dark",
    fits: "nature, health, food, sustainability, travel and wellbeing stories with a human, outdoor register",
    why: "Deep conifer green as the ground and a fresh-leaf lime for growth; coral is the human, warm counterpoint.",
    theme: { background: "#0E1F19", surface: "#173128", ink: "#EAF2E5", muted: "#9FB7A8", accent: "#B7E23B", accent2: "#FF7B54", danger: "#FF6B6B", display: "Young Serif", text: "Figtree", mono: "IBM Plex Mono", backdrop: "contour", displayWeight: 400, displayTracking: -0.01, caption: "solid" },
    fonts: [{ package: "young-serif", family: "Young Serif", weights: [400] }, { package: "figtree", family: "Figtree", weights: [400, 600, 700] }, plexMono],
    audio: { music: { style: "warm", bpm: 84, key: "Eb", mode: "major" }, voice: { voice: "en_US-ryan-high", style: "calm" } } },
  { id: "noir-cinema", name: "Noir Cinema", tone: "dark",
    fits: "trailers, storytelling, cinematic essays, mysteries and dramatic reveals",
    why: "Near-black with no hue and film-red plus faded gold; the emptiness is the point, so the backdrop stays out of the way.",
    theme: { background: "#0A0A0B", surface: "#161618", ink: "#F5F2EE", muted: "#9A9AA2", accent: "#E5202A", accent2: "#C9B27C", danger: "#FF4B55", display: "Anton", text: "Hanken Grotesk", mono: "IBM Plex Mono", backdrop: "none", displayWeight: 400, displayTracking: 0.01, caption: "outline" },
    fonts: [{ package: "anton", family: "Anton", weights: [400] }, { package: "hanken-grotesk", family: "Hanken Grotesk", weights: [400, 600, 700] }, plexMono],
    audio: { music: { style: "tense", bpm: 68, key: "C#", mode: "minor" }, voice: { voice: "en_GB-alan-medium", style: "calm" } } },
];

export const DEFAULT_LOOK = "paper-lab";
export const lookById = (id: unknown): Look | undefined => LOOKS.find((look) => look.id === id);

/** Pick a look from a topic or brief by the vocabulary each look fits. */
export function suggestLook(brief: string): Look {
  const text = brief.toLowerCase();
  const hints: Array<[string, RegExp]> = [
    ["archive-brass", /\b(histor|biograph|ancient|empire|war|century|museum|culture|documentary|legacy|philosoph)\w*/],
    ["ledger-green", /\b(money|financ|econom|market|invest|business|stock|bank|startup|pricing|revenue|budget)\w*/],
    ["field-notes", /\b(nature|health|food|recipe|travel|sustainab|climate|garden|wellness|fitness|animal|ocean|forest)\w*/],
    ["noir-cinema", /\b(trailer|cinematic|mystery|thriller|story|horror|dramatic|film|noir)\w*/],
    ["sunrise-kinetic", /\b(shorts?|reels?|tiktok|tips?|hacks?|quick|how-?to|product|launch|announce)\w*/],
    ["press-room", /\b(investigat|expos[ée]|opinion|commentary|industry|infrastructure|report|news|scandal|politic)\w*/],
    ["carbon-signal", /\b(software|code|coding|program|machine learning|neural|\bai\b|llm|model|network|system|hardware|chip|cyber|devops|api|database|linux|kernel)\w*/],
  ];
  for (const [id, pattern] of hints) if (pattern.test(text)) return lookById(id)!;
  return lookById(DEFAULT_LOOK)!;
}

/** Fontsource dependency map (exact versions) for a set of fonts. */
export const FONT_VERSIONS: Record<string, string> = Object.fromEntries(LOOKS.flatMap((look) => look.fonts).map((font) => [font.package, "5.3.0"]));
export const fontDependencies = (fonts: FontChoice[]): Record<string, string> =>
  Object.fromEntries([...new Set(fonts.map((font) => font.package))].sort().map((name) => [`@fontsource/${name}`, FONT_VERSIONS[name] ?? "5.3.0"]));

/** Source of src/fonts.ts: latin subsets only (small bundles), loaded before rendering. */
export function fontsSource(fonts: FontChoice[]): string {
  const imports = fonts.flatMap((font) => font.weights.map((weight) => `import "@fontsource/${font.package}/latin-${weight}.css";`));
  const faces = fonts.flatMap((font) => font.weights.map((weight) => `"${weight} 40px '${font.family}'"`));
  return `// Local, pinned font files (OFL, @fontsource, latin subset). Rendering never
// depends on network fonts or on whatever happens to be installed on the host.
${imports.join("\n")}
import { continueRender, delayRender } from "remotion";

const handle = delayRender("Loading fonts");
const faces = [${faces.join(", ")}];
Promise.all(faces.map((face) => document.fonts.load(face))).then(() => continueRender(handle), () => continueRender(handle));
`;
}

// ───────────────────────────── design lint ─────────────────────────────

/** `id` lets a brief that explicitly asks for a flagged choice (a terminal-styled
 * video with mono type) opt out through video.json `lint.allow`. */
export type LintIssue = { severity: "error" | "warn"; id: string; message: string };
const hex = (color: unknown): [number, number, number] | null => {
  const m = /^#([0-9a-f]{6})$/i.exec(typeof color === "string" ? color.trim() : "");
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const luminance = ([r, g, b]: [number, number, number]) => {
  const c = [r, g, b].map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
export function contrast(a: unknown, b: unknown): number | null {
  const ca = hex(a), cb = hex(b);
  if (!ca || !cb) return null;
  const [hi, lo] = [luminance(ca), luminance(cb)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function hsl(color: unknown): { h: number; s: number; l: number } | null {
  const c = hex(color);
  if (!c) return null;
  const [r, g, b] = c.map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

const DEFAULT_FONTS = new Set(["inter", "space grotesk", "geist", "instrument serif", "roboto", "arial", "helvetica", "poppins", "montserrat", "open sans", "system-ui", "sans-serif"]);
const MONO_FONTS = /\b(mono|code|courier|consolas|menlo)\b/i;
// The palette this template shipped with before looks existed: any project
// still on it was never art-directed.
const LEGACY_PALETTE = { background: "#0b0f17", accent: "#5eead4", accent2: "#f5b544" };
const PLACEHOLDERS = [/replace this line/i, /a title that states the idea/i, /one short supporting line/i, /describe what the diagram shows/i, /^untitled video$/i, /signals flow through the network/i, /^chapter one$/i];

/** Findings about default-looking design in a video.json theme and copy. */
export function lintDesign(spec: any): LintIssue[] {
  const issues: LintIssue[] = [];
  const allow = new Set<string>(Array.isArray(spec?.lint?.allow) ? spec.lint.allow : []);
  const err = (id: string, message: string) => { if (!allow.has(id)) issues.push({ severity: "error", id, message }); };
  const warn = (id: string, message: string) => { if (!allow.has(id)) issues.push({ severity: "warn", id, message }); };
  const theme = spec?.theme ?? {};
  const display = String(theme.display ?? "").toLowerCase(), text = String(theme.text ?? "").toLowerCase();
  if (MONO_FONTS.test(display)) err("mono-display", `Display font "${theme.display}" is monospace; a mono face stands in for personality. Use it only for code and data (theme.mono) and choose a real display face (see the art-direction reference).`);
  for (const [role, family] of [["display", display], ["text", text]] as const) if (DEFAULT_FONTS.has(family)) warn("default-font", `The ${role} font "${theme[role]}" is a default pick that signals no typographic decision; choose a pairing you would not reuse on an unrelated project.`);
  if (display && display === text) warn("same-font", "Display and text fonts are the same family; hierarchy then rests on size alone.");
  const bg = String(theme.background ?? "").toLowerCase();
  if (bg === LEGACY_PALETTE.background && String(theme.accent ?? "").toLowerCase() === LEGACY_PALETTE.accent) err("legacy-palette", "The palette is the old template default (navy with teal and amber). Apply a look with video_project action:\"look\" or derive a palette from the subject.");
  const accent = hsl(theme.accent), back = hsl(theme.background);
  if (accent && accent.s > 0.45 && accent.h >= 235 && accent.h <= 335) warn("indigo-accent", `Accent ${theme.accent} sits in the indigo-to-magenta band that is the loudest machine-made tell; derive the accent from the subject.`);
  if (back && back.l > 0.85 && back.h >= 30 && back.h <= 60 && back.s > 0.15 && accent && accent.h >= 5 && accent.h <= 25) warn("cream-terracotta", "A cream ground with a terracotta accent is the reaction-to-slop default; use it only if the brief asks.");
  if (back && back.s < 0.04 && (back.l < 0.03 || back.l > 0.97)) warn("pure-neutral", "The background is pure black or white; give the neutral a deliberate hue bias and say why.");
  const checks: Array<[string, unknown, unknown, number]> = [["ink on background", theme.ink, theme.background, 7], ["muted text on background", theme.muted, theme.background, 4.5], ["accent on background", theme.accent, theme.background, 3]];
  for (const [label, a, b, min] of checks) { const ratio = contrast(a, b); if (ratio !== null && ratio < min) warn("contrast", `Contrast of ${label} is ${ratio.toFixed(1)}:1; needs at least ${min}:1 to survive phones and compression.`); }
  const scenes: any[] = Array.isArray(spec?.scenes) ? spec.scenes.filter((scene: any) => scene && typeof scene === "object" && !Array.isArray(scene)) : [];
  const left: string[] = [];
  const scan = (value: unknown) => { if (typeof value === "string") { if (PLACEHOLDERS.some((p) => p.test(value.trim()))) left.push(value.trim().slice(0, 40)); } else if (Array.isArray(value)) value.forEach(scan); else if (value && typeof value === "object") Object.values(value).forEach(scan); };
  scan(spec?.title); scenes.forEach((scene) => { scan(scene.narration); scan(scene.props); });
  if (left.length) err("placeholder", `Template placeholder text is still present: ${[...new Set(left)].map((s) => JSON.stringify(s)).join(", ")}.`);
  if (scenes.length >= 4 && new Set(scenes.map((scene) => scene.component)).size === 1) warn("identical-scenes", `All ${scenes.length} scenes use the ${scenes[0].component} component; a sequence of identical layouts reads as a slideshow.`);
  return issues;
}
