/** Derive a look for a video from its subject instead of picking one from a short list. A fixed list is
 * itself a default: the same topic always lands on the same eight palettes. This module reads the brief
 * for character (formal, warm, loud, technical, organic, historical, energetic, dark) and domain, then
 * builds an accent hue family, neutrals, a type pairing, a backdrop, captions, music and voice from it,
 * deterministically from the brief and a variation number. Colours come from the shared OKLCH palette
 * generator (every text role is searched to its contrast target). Every candidate is linted; one that
 * reads as a house default, or names something the creative direction avoids, is re-rolled. Pure. */
import { contrast, derivePalette, oklchToHex } from "../../skills/signature-experience/scripts/palette.mjs";
import { LOOKS, lintDesign, type FontChoice, type Look, type LookTheme } from "./video-looks.ts";

type Trait = "formal" | "warm" | "loud" | "tech" | "organic" | "era" | "energy" | "dark";
type Character = Record<Trait, number>;
const TRAITS: Trait[] = ["formal", "warm", "loud", "tech", "organic", "era", "energy", "dark"];

/** Domains the brief can name. `hues` are OKLCH hue families a subject plausibly owns (the seed picks one),
 * chosen from the subject's own world (lamp amber, verdigris, safety orange, sodium, chalk), never from a default. */
const DOMAINS: Array<{ id: string; test: RegExp; traits: Partial<Character>; hues: number[] }> = [
  { id: "history", test: /\b(histor|biograph|ancient|empire|war|century|museum|archive|culture|legacy|philosoph|myth|dynasty)\w*/, traits: { formal: 0.8, warm: 0.7, era: 0.95, energy: 0.2, dark: 0.7, loud: 0.3 }, hues: [75, 55, 175, 28] },
  { id: "finance", test: /\b(money|financ|econom|market|invest|business|stock|bank|startup|pricing|revenue|budget|trade|inflation)\w*/, traits: { formal: 0.7, tech: 0.4, energy: 0.45, dark: 0.2, loud: 0.4 }, hues: [150, 178, 88, 28] },
  { id: "science", test: /\b(science|physic|chemist|biolog|engineer|mechanic|how .* works?|experiment|laborator|math|quantum|energy|electric)\w*/, traits: { formal: 0.5, tech: 0.8, energy: 0.5, dark: 0.35, loud: 0.4 }, hues: [205, 88, 28, 152, 232] },
  { id: "software", test: /\b(software|code|coding|program|machine learning|neural|\bai\b|llm|model|network|system|hardware|chip|cyber|devops|api|database|linux|kernel|security|encrypt|algorithm|data)\w*/, traits: { tech: 1, formal: 0.45, loud: 0.4, dark: 0.75, energy: 0.55 }, hues: [88, 150, 205, 28, 340] },
  { id: "nature", test: /\b(nature|health|food|recipe|travel|sustainab|climate|garden|wellness|fitness|animal|forest|plant|farm|medicine|sleep)\w*/, traits: { warm: 0.8, organic: 1, energy: 0.4, dark: 0.35, loud: 0.3 }, hues: [128, 150, 58, 28, 215] },
  { id: "ocean", test: /\b(ocean|sea|tide|water|river|coast|marine|rain|storm|glacier|ice)\w*/, traits: { organic: 0.8, energy: 0.35, dark: 0.55, warm: 0.4, loud: 0.3 }, hues: [205, 178, 88, 28] },
  { id: "space", test: /\b(space|astronom|planet|galax|orbit|rocket|cosmos|telescope|moon|star)\w*/, traits: { dark: 1, tech: 0.6, energy: 0.4, formal: 0.5, loud: 0.4 }, hues: [88, 205, 28, 345] },
  { id: "cinema", test: /\b(trailer|cinematic|mystery|thriller|story|horror|dramatic|film|noir|crime|heist)\w*/, traits: { dark: 1, loud: 0.7, formal: 0.6, energy: 0.5 }, hues: [28, 88, 205, 355] },
  { id: "sport", test: /\b(sport|athlet|workout|race|launch|product|announce|tips?|hacks?|reels?|shorts?|tiktok|quick)\w*/, traits: { energy: 1, loud: 1, dark: 0.45 }, hues: [98, 58, 28, 128, 345] },
  { id: "creative", test: /\b(music|art|design|creative|fashion|photograph|illustrat|poetry|dance|theatre|theater|craft)\w*/, traits: { warm: 0.6, loud: 0.6, energy: 0.6 }, hues: [355, 128, 58, 205] },
  { id: "education", test: /\b(educat|learn|kids?|children|school|lesson|tutorial|beginner|explain)\w*/, traits: { warm: 0.7, energy: 0.6, loud: 0.5, dark: 0.1 }, hues: [98, 28, 152, 205] },
  { id: "news", test: /\b(investigat|expos[ée]|opinion|commentary|industry|infrastructure|report|news|scandal|politic|election|policy)\w*/, traits: { formal: 0.7, loud: 0.6, dark: 0.6, energy: 0.55 }, hues: [28, 98, 178] },
  { id: "luxury", test: /\b(luxur|premium|architect|interior|jewel|watch|perfume|boutique|elegan)\w*/, traits: { formal: 1, loud: 0.3, energy: 0.25, warm: 0.4, dark: 0.65 }, hues: [78, 355, 178] },
  { id: "game", test: /\b(game|gaming|arcade|retro|pixel|esports?)\w*/, traits: { loud: 0.8, tech: 0.6, dark: 0.8, energy: 0.8 }, hues: [152, 58, 335, 205] },
];
/** Colour words in the brief name the user's own hue; they win over the domain. */
const COLOR_WORDS: Array<[RegExp, number]> = [
  [/\b(?:red|crimson|scarlet|vermilion)\b/, 27], [/\b(?:orange|amber|tangerine|rust)\b/, 55], [/\b(?:yellow|gold|golden|mustard)\b/, 95], [/\b(?:lime|chartreuse)\b/, 125],
  [/\b(?:green|emerald|jade|forest)\b/, 150], [/\b(?:teal|turquoise|aqua)\b/, 190], [/\b(?:cyan|sky)\b/, 215], [/\b(?:blue|cobalt|navy|azure)\b/, 250], [/\b(?:purple|violet|indigo|lavender)\b/, 295], [/\b(?:pink|magenta|rose|fuchsia)\b/, 345],
];
const HUE_NAMES: Array<[number, string]> = [[18, "rose-red"], [40, "vermilion"], [68, "orange"], [92, "amber"], [112, "yellow"], [138, "lime"], [162, "green"], [186, "teal"], [210, "cyan"], [240, "azure"], [268, "blue"], [310, "violet"], [345, "magenta"], [361, "rose"]];
const hueName = (hue: number) => HUE_NAMES.find(([limit]) => hue < limit)?.[1] ?? "rose";

type Face = { package: string; family: string; weights: number[]; weight: number; tracking: number; kind: string; traits: Partial<Character> };
/** Display faces by structure and temperament. Weights were verified present in @fontsource at the pinned version. */
const DISPLAY: Face[] = [
  { package: "bricolage-grotesque", family: "Bricolage Grotesque", weights: [700, 800], weight: 800, tracking: -0.025, kind: "grotesque", traits: { warm: 0.6, loud: 0.6, tech: 0.4 } },
  { package: "familjen-grotesk", family: "Familjen Grotesk", weights: [700], weight: 700, tracking: -0.02, kind: "grotesque", traits: { warm: 0.5, loud: 0.5, tech: 0.5 } },
  { package: "epilogue", family: "Epilogue", weights: [800], weight: 800, tracking: -0.025, kind: "grotesque", traits: { formal: 0.5, loud: 0.6, tech: 0.4 } },
  { package: "chivo", family: "Chivo", weights: [700, 800], weight: 800, tracking: -0.02, kind: "grotesque", traits: { formal: 0.6, tech: 0.5, loud: 0.5 } },
  { package: "schibsted-grotesque", family: "Schibsted Grotesque", weights: [700, 800], weight: 800, tracking: -0.02, kind: "grotesque", traits: { formal: 0.6, tech: 0.7, loud: 0.4 } },
  { package: "rethink-sans", family: "Rethink Sans", weights: [700, 800], weight: 800, tracking: -0.02, kind: "grotesque", traits: { warm: 0.6, formal: 0.4, energy: 0.5 } },
  { package: "gabarito", family: "Gabarito", weights: [800], weight: 800, tracking: -0.015, kind: "geometric", traits: { warm: 0.7, loud: 0.5, energy: 0.7 } },
  { package: "red-hat-display", family: "Red Hat Display", weights: [800, 900], weight: 900, tracking: -0.02, kind: "geometric", traits: { warm: 0.5, formal: 0.5, tech: 0.4 } },
  { package: "syne", family: "Syne", weights: [700, 800], weight: 800, tracking: -0.01, kind: "wide", traits: { loud: 0.8, warm: 0.4, tech: 0.3, energy: 0.6 } },
  { package: "unbounded", family: "Unbounded", weights: [700, 800], weight: 700, tracking: -0.01, kind: "wide", traits: { loud: 0.8, tech: 0.6, energy: 0.8, warm: 0.3 } },
  { package: "big-shoulders-display", family: "Big Shoulders Display", weights: [700, 800], weight: 800, tracking: 0, kind: "condensed", traits: { loud: 0.7, formal: 0.5, tech: 0.4, energy: 0.6 } },
  { package: "sofia-sans-extra-condensed", family: "Sofia Sans Extra Condensed", weights: [700, 800], weight: 800, tracking: 0, kind: "condensed", traits: { formal: 0.6, loud: 0.6, tech: 0.4 } },
  { package: "barlow-condensed", family: "Barlow Condensed", weights: [700, 800], weight: 800, tracking: 0.005, kind: "condensed", traits: { tech: 0.7, energy: 0.7, loud: 0.5 } },
  { package: "saira-extra-condensed", family: "Saira Extra Condensed", weights: [700, 800], weight: 800, tracking: 0.005, kind: "condensed", traits: { tech: 0.9, energy: 0.8, loud: 0.5 } },
  { package: "anton", family: "Anton", weights: [400], weight: 400, tracking: 0.01, kind: "condensed", traits: { loud: 1, dark: 0.7, energy: 0.7 } },
  { package: "league-gothic", family: "League Gothic", weights: [400], weight: 400, tracking: 0.015, kind: "condensed", traits: { era: 0.6, formal: 0.6, loud: 0.7 } },
  { package: "dela-gothic-one", family: "Dela Gothic One", weights: [400], weight: 400, tracking: -0.01, kind: "heavy", traits: { loud: 1, warm: 0.5, energy: 0.8 } },
  { package: "bowlby-one", family: "Bowlby One", weights: [400], weight: 400, tracking: -0.01, kind: "heavy", traits: { loud: 0.9, warm: 0.7, energy: 0.8, era: 0.4 } },
  { package: "alfa-slab-one", family: "Alfa Slab One", weights: [400], weight: 400, tracking: -0.005, kind: "slab", traits: { loud: 0.9, era: 0.6, warm: 0.6 } },
  { package: "zilla-slab", family: "Zilla Slab", weights: [700], weight: 700, tracking: -0.01, kind: "slab", traits: { tech: 0.5, warm: 0.5, formal: 0.5 } },
  { package: "bitter", family: "Bitter", weights: [700, 800], weight: 800, tracking: -0.01, kind: "slab", traits: { warm: 0.6, formal: 0.6, era: 0.4 } },
  { package: "young-serif", family: "Young Serif", weights: [400], weight: 400, tracking: -0.01, kind: "serif", traits: { warm: 0.9, organic: 0.8, era: 0.3, formal: 0.4 } },
  { package: "fraunces", family: "Fraunces", weights: [700, 900], weight: 900, tracking: -0.02, kind: "serif", traits: { warm: 0.8, organic: 0.6, era: 0.5, loud: 0.5 } },
  { package: "newsreader", family: "Newsreader", weights: [600, 700], weight: 700, tracking: -0.01, kind: "serif", traits: { formal: 0.9, era: 0.9, warm: 0.5, energy: 0.2 } },
  { package: "literata", family: "Literata", weights: [700, 800], weight: 800, tracking: -0.015, kind: "serif", traits: { formal: 0.8, era: 0.7, warm: 0.5 } },
  { package: "source-serif-4", family: "Source Serif 4", weights: [700, 800], weight: 800, tracking: -0.015, kind: "serif", traits: { formal: 0.8, tech: 0.3, era: 0.5 } },
  { package: "eb-garamond", family: "EB Garamond", weights: [700, 800], weight: 800, tracking: -0.01, kind: "serif", traits: { formal: 1, era: 1, warm: 0.6, energy: 0.1 } },
  { package: "spectral", family: "Spectral", weights: [700, 800], weight: 800, tracking: -0.01, kind: "serif", traits: { formal: 0.9, era: 0.8, warm: 0.5, energy: 0.2 } },
  { package: "crimson-pro", family: "Crimson Pro", weights: [700, 800], weight: 800, tracking: -0.01, kind: "serif", traits: { formal: 0.8, era: 0.8, warm: 0.6 } },
  { package: "gloock", family: "Gloock", weights: [400], weight: 400, tracking: -0.01, kind: "didone", traits: { formal: 0.9, loud: 0.6, era: 0.6, dark: 0.6 } },
  { package: "bodoni-moda", family: "Bodoni Moda", weights: [700, 800], weight: 800, tracking: -0.015, kind: "didone", traits: { formal: 1, loud: 0.5, warm: 0.3, energy: 0.3 } },
  { package: "rozha-one", family: "Rozha One", weights: [400], weight: 400, tracking: -0.01, kind: "didone", traits: { formal: 0.8, loud: 0.8, era: 0.6 } },
  { package: "abril-fatface", family: "Abril Fatface", weights: [400], weight: 400, tracking: -0.01, kind: "didone", traits: { loud: 0.8, formal: 0.7, era: 0.6, warm: 0.5 } },
  { package: "cormorant", family: "Cormorant", weights: [700], weight: 700, tracking: -0.01, kind: "didone", traits: { formal: 1, era: 0.8, energy: 0.1, warm: 0.5 } },
];
const TEXT_SANS: Face[] = ["hanken-grotesk:Hanken Grotesk", "albert-sans:Albert Sans", "work-sans:Work Sans", "public-sans:Public Sans", "figtree:Figtree", "source-sans-3:Source Sans 3", "ibm-plex-sans:IBM Plex Sans", "karla:Karla", "mulish:Mulish", "atkinson-hyperlegible:Atkinson Hyperlegible", "red-hat-text:Red Hat Text", "be-vietnam-pro:Be Vietnam Pro", "overpass:Overpass", "commissioner:Commissioner", "instrument-sans:Instrument Sans", "onest:Onest"]
  .map((entry) => { const [pkg, family] = entry.split(":"); return { package: pkg, family, weights: pkg === "atkinson-hyperlegible" ? [400, 700] : [400, 600, 700], weight: 400, tracking: 0, kind: "sans", traits: {} }; });
const TEXT_SERIF: Face[] = ["source-serif-4:Source Serif 4", "literata:Literata", "crimson-pro:Crimson Pro", "lora:Lora", "spectral:Spectral", "ibm-plex-serif:IBM Plex Serif", "libre-baskerville:Libre Baskerville", "merriweather:Merriweather"]
  .map((entry) => { const [pkg, family] = entry.split(":"); return { package: pkg, family, weights: pkg === "libre-baskerville" || pkg === "merriweather" ? [400, 700] : [400, 600, 700], weight: 400, tracking: 0, kind: "serif-text", traits: {} }; });
const MONO: Array<[string, string, number]> = [["ibm-plex-mono", "IBM Plex Mono", 0.3], ["dm-mono", "DM Mono", 0.4], ["jetbrains-mono", "JetBrains Mono", 0.9], ["red-hat-mono", "Red Hat Mono", 0.5], ["martian-mono", "Martian Mono", 1], ["azeret-mono", "Azeret Mono", 0.7], ["spline-sans-mono", "Spline Sans Mono", 0.6], ["fira-code", "Fira Code", 0.8]];
const BACKDROPS: Array<[LookTheme["backdrop"], Partial<Character>]> = [["lattice", { tech: 1, dark: 0.95, loud: 0.5 }], ["rules", { tech: 0.6, formal: 0.7, dark: 0.3 }], ["ticks", { tech: 0.9, formal: 0.5, energy: 0.4 }], ["halftone", { loud: 0.9, warm: 0.5, energy: 0.7 }], ["contour", { organic: 0.9, era: 0.6, warm: 0.6 }], ["flow", { organic: 0.7, energy: 0.5, dark: 0.7 }], ["none", { formal: 0.9, loud: 0.3, era: 0.5, dark: 0.9 }]];
const VOICES: Record<string, string[]> = { documentary: ["en_US-ryan-high", "en_GB-alan-medium", "en_GB-northern_english_male-medium"], calm: ["en_GB-alan-medium", "en_US-lessac-high", "en_GB-jenny_dioco-medium"], energetic: ["en_US-ryan-high", "en_US-amy-medium"], intimate: ["en_GB-jenny_dioco-medium", "en_US-lessac-medium", "en_US-amy-medium"] };

const fnv = (text: string) => { let h = 2166136261; for (const c of text) { h ^= c.codePointAt(0)!; h = Math.imul(h, 16777619); } return h >>> 0; };
export const mulberry = (seed: number) => () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const distance = (character: Character, traits: Partial<Character>) => Object.entries(traits).reduce((sum, [trait, value]) => sum + (character[trait as Trait] - (value as number)) ** 2, 0);
const pick = <T,>(items: T[], random: () => number, scored: (item: T) => number, top = 3): T => [...items].sort((a, b) => scored(a) - scored(b)).slice(0, top)[Math.floor(random() * Math.min(top, items.length))];

/** Hue of a #rrggbb colour in OKLCH degrees (for a brand accent the user supplied). */
export function oklchHue(hex: string): { hue: number; chroma: number } {
  const n = parseInt(hex.slice(1), 16), lin = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const [r, g, b] = [lin((n >> 16) & 255), lin((n >> 8) & 255), lin(n & 255)];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, c = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { hue: ((Math.atan2(c, a) * 180) / Math.PI + 360) % 360, chroma: Math.hypot(a, c) };
}

export type DeriveOptions = { seed?: number; variation?: number; accent?: string; tone?: "dark" | "light"; /** words the creative direction avoids (colours, fonts, patterns, tone) */ avoid?: string[] };

/** Everything the brief says about the subject, as trait weights and candidate hue families. */
export function readBrief(brief: string, random: () => number) {
  const text = brief.toLowerCase();
  const matched = DOMAINS.filter((domain) => domain.test.test(text));
  const character = Object.fromEntries(TRAITS.map((trait) => [trait, 0])) as Character;
  const weight = Object.fromEntries(TRAITS.map((trait) => [trait, 0])) as Record<Trait, number>;
  for (const domain of matched) for (const [trait, value] of Object.entries(domain.traits)) { character[trait as Trait] += value as number; weight[trait as Trait] += 1; }
  // Traits no domain speaks to stay neutral when the subject was recognised; for an unfamiliar subject they are drawn from the
  // seed, so the look is still considered and varied instead of falling back to one default.
  for (const trait of TRAITS) character[trait] = weight[trait] ? character[trait] / weight[trait] : matched.length ? 0.35 : 0.25 + random() * 0.5;
  if (/\b(calm|quiet|gentle|slow|meditat|soft)\w*/.test(text)) { character.energy = Math.min(character.energy, 0.25); character.loud = Math.min(character.loud, 0.3); }
  if (/\b(bold|loud|punchy|fast|hype|intense|wild)\w*/.test(text)) { character.energy = Math.max(character.energy, 0.85); character.loud = Math.max(character.loud, 0.85); }
  if (/\b(playful|fun|cheerful|friendly)\w*/.test(text)) { character.warm = Math.max(character.warm, 0.75); character.formal = Math.min(character.formal, 0.3); }
  if (/\b(serious|formal|corporate|official)\w*/.test(text)) character.formal = Math.max(character.formal, 0.85);
  if (/\b(night|dark|noir)\b/.test(text)) character.dark = Math.max(character.dark, 0.9);
  if (/\b(daylight|bright|sunny|morning|clean|light mode)\b/.test(text)) character.dark = Math.min(character.dark, 0.15);
  const named = COLOR_WORDS.find(([pattern]) => pattern.test(text))?.[1];
  const families = matched.flatMap((domain) => domain.hues);
  return { character, domains: matched.map((domain) => domain.id), named, families: families.length ? families : [28, 58, 88, 128, 152, 178, 205, 232, 345].filter(() => true) };
}

/** Terms a candidate can be described by, for matching against a creative direction's avoid list. */
function descriptors(look: Look, hue: number, dark: boolean): Set<string> {
  const terms = new Set<string>([hueName(hue), dark ? "dark" : "light", look.theme.backdrop, look.theme.display.toLowerCase(), look.theme.text.toLowerCase(), look.theme.caption]);
  const kind = DISPLAY.find((face) => face.family === look.theme.display)?.kind;
  if (kind) terms.add(kind);
  if (kind === "serif" || kind === "didone" || kind === "slab") terms.add("serif");
  if (kind === "condensed") terms.add("condensed");
  if (hue >= 255 && hue <= 330) { terms.add("purple"); terms.add("violet"); terms.add("indigo"); }
  if (hue >= 20 && hue <= 60) { terms.add("orange"); terms.add("red"); terms.add("warm"); }
  if (hue >= 190 && hue <= 260) { terms.add("blue"); terms.add("cool"); }
  if (hue >= 95 && hue <= 175) terms.add("green");
  return terms;
}

function buildLook(brief: string, seed: number, variation: number, options: DeriveOptions): Look & { derived: NonNullable<Look["derived"]> } {
  const random = mulberry(fnv(`${seed}:${variation}`));
  const { character, domains, named, families } = readBrief(brief, mulberry(fnv(`${seed}:traits`)));
  const brand = options.accent && /^#[0-9a-f]{6}$/i.test(options.accent) ? oklchHue(options.accent) : undefined;
  const hue = brand ? brand.hue : named ?? (families[Math.floor(random() * families.length)] + (random() - 0.5) * 16 + 360) % 360;
  const dark = options.tone ? options.tone === "dark" : character.dark + (random() - 0.5) * 0.3 > 0.5;
  const mood = character.formal > 0.7 && character.loud < 0.45 ? "muted" : character.loud > 0.65 ? "vivid" : character.organic > 0.7 ? "soft" : dark ? (random() < 0.5 ? "vivid" : "deep") : random() < 0.5 ? "deep" : "vivid";
  const warmHue = hue >= 15 && hue <= 80;
  const harmony = warmHue ? ["analogous", "mono", "triad"][Math.floor(random() * 3)] : (character.tech > 0.7 ? ["complement", "split", "analogous"] : character.organic > 0.7 ? ["analogous", "split", "mono"] : character.formal > 0.7 ? ["mono", "analogous", "complement"] : ["split", "analogous", "complement", "triad"])[Math.floor(random() * 3)];
  const bias = [String(Math.round((hue + 180) % 360)), "accent", "accent", character.warm > 0.55 ? "warm" : "cool"][Math.floor(random() * 4)];
  const build = (neutralBias: string) => derivePalette({ hue, chroma: brand ? Math.min(0.26, Math.max(0.08, brand.chroma)) : undefined, mood, bias: neutralBias, harmony, dark: true });
  let palette = build(bias);
  // A pale ground tinted toward yellow is the cream default; light looks lean cool unless the brief asks for paper.
  if (!dark && palette.neutralHue >= 50 && palette.neutralHue <= 110 && !/\b(?:cream|ivory|paper|parchment|vintage)\b/i.test(brief)) palette = build("cool");
  const roles = dark ? palette.dark : palette.light;
  // Danger is a red that clears the ground's contrast; the accent roles already do.
  let danger = oklchToHex(dark ? 0.72 : 0.5, 0.19, 27);
  for (let l = dark ? 0.72 : 0.5, i = 0; i < 40 && contrast(danger, roles.bg) < 4.5; i++) { l += dark ? 0.01 : -0.01; danger = oklchToHex(l, 0.19, 27); }

  const display = pick(DISPLAY, random, (face) => distance(character, face.traits));
  const serifDisplay = display.kind === "serif" || display.kind === "didone";
  // Text face contrasts with the display's structure: sans under a serif, a serif text face under a heavy sans when the subject is formal or historical.
  const text = serifDisplay || character.formal + character.era < 1.2 ? pick(TEXT_SANS, random, () => random(), 5) : pick([...TEXT_SANS, ...TEXT_SERIF.filter((face) => face.family !== display.family)], random, () => random(), 8);
  const mono = pick(MONO, random, (entry) => (entry[2] - character.tech) ** 2, 3);
  const backdrop = pick(BACKDROPS, random, (entry) => distance(character, entry[1]), 2)[0];
  const caption: LookTheme["caption"] = character.loud > 0.65 ? "outline" : character.formal > 0.7 && character.era > 0.6 ? "plain" : "solid";
  const theme: LookTheme = {
    background: roles.bg, surface: roles.surface, ink: roles.ink, muted: roles.muted, accent: roles.link, accent2: roles["accent-2"] ?? roles["accent-3"] ?? roles.link, danger,
    display: display.family, text: text.family, mono: mono[1], backdrop, displayWeight: display.weight, displayTracking: display.tracking, caption,
  };
  const energy = clamp(character.energy);
  const style = energy > 0.8 ? (character.loud > 0.7 ? "driving" : "upbeat") : character.dark > 0.8 && character.loud > 0.5 ? "tense" : character.tech > 0.7 ? "focused" : energy < 0.3 && character.era > 0.5 ? "reflective" : character.warm > 0.65 || character.organic > 0.7 ? "warm" : character.formal > 0.65 ? "confident" : "curious";
  const voiceStyle = energy > 0.7 ? "energetic" : energy < 0.35 && character.warm > 0.6 ? "intimate" : energy < 0.4 && (character.era > 0.5 || character.formal > 0.6) ? "calm" : "documentary";
  const keys = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  const hash = fnv(`${brief}:${variation}:${seed}`).toString(16).padStart(8, "0").slice(0, 6);
  const fonts: FontChoice[] = [
    { package: display.package, family: display.family, weights: display.weights.length > 1 ? display.weights : display.weights },
    { package: text.package, family: text.family, weights: text.weights },
    { package: mono[0], family: mono[1], weights: [400, 500] },
  ];
  const look: Look = {
    id: `derived-${hash}`, name: `${hueName(hue)[0].toUpperCase()}${hueName(hue).slice(1)} ${display.kind}`, tone: dark ? "dark" : "light",
    fits: domains.length ? `derived for ${domains.join(" / ")}` : "derived from the brief's own character",
    why: `Accent hue ${Math.round(hue)}° (${hueName(hue)}) ${named ? "named in the brief" : brand ? "taken from the supplied brand colour" : `from the ${domains.join(" / ") || "unspecified"} subject's own palette`}; neutrals tinted toward ${Math.round(palette.neutralHue)}° at chroma 0.012; ${harmony} harmony; ${display.family} (${display.kind}) over ${text.family} for structure contrast; ${backdrop} backdrop.`,
    theme, fonts,
    audio: { music: { style, bpm: Math.round(66 + 56 * energy + (random() - 0.5) * 8), key: keys[Math.floor(random() * keys.length)], mode: dark || character.formal > 0.7 ? (random() < 0.5 ? "minor" : "dorian") : "major" }, voice: { voice: VOICES[voiceStyle][Math.floor(random() * VOICES[voiceStyle].length)], style: voiceStyle } },
    derived: { seed, variation, hue: Math.round(hue), harmony, domains, character: Object.fromEntries(TRAITS.map((trait) => [trait, Number(character[trait].toFixed(2))])) },
  };
  return look as Look & { derived: NonNullable<Look["derived"]> };
}

/** A look for this brief. Deterministic for (brief, seed, variation); re-rolls candidates that lint as defaults
 * or that the creative direction avoids, and says so in `rerolls`. */
export function deriveLook(brief: string, options: DeriveOptions = {}): Look & { derived: NonNullable<Look["derived"]> } & { rerolls: string[] } {
  const seed = options.seed ?? fnv(brief.trim().toLowerCase() || "untitled");
  const avoid = new Set((options.avoid ?? []).flatMap((entry) => entry.toLowerCase().split(/[^a-z0-9]+/)).filter((word) => word.length > 2));
  const rerolls: string[] = [];
  let last: ReturnType<typeof buildLook> | undefined;
  for (let attempt = 0; attempt < 12; attempt++) {
    const look = buildLook(brief, seed, (options.variation ?? 0) + attempt, options);
    last = look;
    const flagged = lintDesign({ theme: look.theme, scenes: [] }).filter((issue) => ["indigo-accent", "cream-terracotta", "pure-neutral", "contrast", "default-font", "same-font"].includes(issue.id));
    const hits = [...descriptors(look, look.derived.hue, look.tone === "dark")].filter((term) => avoid.has(term));
    // The brief may ask for an indigo or cream look itself; only unrequested defaults are re-rolled.
    if (flagged.length === 0 && hits.length === 0) return { ...look, rerolls };
    if (/\b(?:purple|violet|indigo)\b/i.test(brief) && flagged.every((issue) => issue.id === "indigo-accent") && hits.length === 0) return { ...look, rerolls };
    rerolls.push(`variation ${(options.variation ?? 0) + attempt}: ${[...flagged.map((issue) => issue.id), ...hits.map((term) => `avoid:${term}`)].join(", ")}`);
  }
  return { ...last!, rerolls };
}

/** The curated looks stay available by id, as archetypes: structure worth reusing when a brief matches one closely. */
export const curatedIds = (): string[] => LOOKS.map((look) => look.id);
