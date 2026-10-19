/** UI-work detection.
 *
 * WHY: models asked for an interface with no constraints converge on the same
 * two looks (indigo/purple SaaS, cream/terracotta editorial). The harness
 * embeds `ui-design` as a skill; this module decides WHEN an agent
 * is doing interface work and offers that reference when useful.
 *
 * Who decides: deterministic cues frame the question (a UI file being written,
 * UI vocabulary in the request). Jev then settles the ambiguous middle in both
 * directions — "page fault" is not a web page, "make checkout less confusing"
 * is UI work with no UI word — through the typed `ui-work` decision, at
 * roughly 300 input tokens instead of a model turn. Jev unavailable or unsure
 * keeps the heuristic (strong cues count, weak cues do not); Jev refines, it
 * never gates. Editing a UI file is deterministic and needs no judge.
 */
import type { TypedVerdict } from "./micro-intelligence/jev-decisions.ts";
import { mediaFile, mediaWork } from "./media-work.ts";

export const UI_DOCTRINE_SKILL = "ui-design";

const STRONG_PROMPT = /\b(?:ui|ux|gui|user interfaces?|front-?end|web ?sites?|landing ?pages?|home ?pages?|web ?apps?|dashboards?|mock-?ups?|wireframes?|css|tailwind|style ?sheets?|design systems?|hero sections?|nav ?bars?|side ?bars?|modals?|re-?design|re-?style|figma|storefronts?|portfolio sites?|responsive (?:design|layout)|color palettes?|typography|onboarding flow|checkout flow|sign-?up (?:page|flow|form)|login (?:page|screen|form))\b/i;
const WEAK_PROMPT = /\b(?:pages?|layouts?|styles?|styling|screens?|looks?|feels?|buttons?|forms?|themes?|colou?rs?|fonts?|components?|visuals?|designs?|apps?|sites?|interfaces?|widgets?|menus?|animations?|confusing|clunky|ugly|clean(?:er)?|modern|polish(?:ed)?)\b/i;
/** Prose about a subject, not work on it; a question is not an interface task. */
const NARRATIVE = /^\s*(?:what|who|when|where|why|how)\s+(?:is|are|was|were|does|do|did|would|should|can|could)\b|\b(?:explain|describe|summari[sz]e)\b/i;
const NO_UI = /\b(?:no|without|skip)\s+(?:ui|frontend|front-end|gui)\b|\b(?:backend|back-end|cli|api)[- ]only\b|\bheadless\b/i;
const WORK_VERB = /\b(?:add|build|create|design|implement|make|redesign|restyle|fix|improve|change|update|polish|refactor|develop|craft|revamp|rework|tweak|adjust|style|prototype|generate|write)\b/i;

const UI_FILE = /\.(?:html?|css|scss|sass|less|jsx|tsx|vue|svelte|astro|twig|erb|hbs|xaml|qml)$/i;
const EXCLUDED_PATH = /(?:^|\/)(?:node_modules|vendor|dist|build|coverage|fixtures?|__fixtures__|__snapshots__|skills|references|backups)\/|\.(?:min|generated|test|spec|stories)\.|(?:^|\/)(?:SKILL|README|CHANGELOG)\.md$/i;
const SCRIPT_FILE = /\.(?:[cm]?[jt]s|py|rs|kt|swift|dart|java|cs|lua)$/i;
/** GUI toolkits and DOM builders: a script that draws windows or markup is interface work. */
const GUI_CONTENT = /\b(?:tkinter|customtkinter|PyQt\d|PySide\d|kivy|wx\.Frame|Gtk\.\w+|QWidget|JFrame|javafx|SwiftUI|@Composable|package:flutter\/|egui::|document\.createElement|\.innerHTML\s*=|React\.createElement)\b/;

export type UiCue = { strength: "none" | "weak" | "strong"; terms: string[] };

/** Deterministic first reading of a request. `none` never reaches the judge. */
export function uiPromptCue(prompt: string): UiCue {
  const text = typeof prompt === "string" ? prompt.slice(0, 6000) : "";
  // Film work says "typography" and "palette" too; it is not interface work unless it names a surface.
  if (!text.trim() || NARRATIVE.test(text) || NO_UI.test(text) || !WORK_VERB.test(text) || mediaWork(text)) return { strength: "none", terms: [] };
  const strong = [...text.matchAll(new RegExp(STRONG_PROMPT.source, "gi"))].map((m) => m[0].toLowerCase());
  if (strong.length) return { strength: "strong", terms: [...new Set(strong)].slice(0, 6) };
  const weak = [...text.matchAll(new RegExp(WEAK_PROMPT.source, "gi"))].map((m) => m[0].toLowerCase());
  return weak.length ? { strength: "weak", terms: [...new Set(weak)].slice(0, 6) } : { strength: "none", terms: [] };
}

/** A written file is interface work by extension, or by GUI markers in what is written. */
export function uiFileCue(file: string, content?: string): boolean {
  const normalized = String(file ?? "").replaceAll("\\", "/");
  // Remotion acts (.tsx) and video HTML scenes are film frames, not an interface.
  if (!normalized || EXCLUDED_PATH.test(normalized) || mediaFile(normalized, content)) return false;
  if (UI_FILE.test(normalized)) return true;
  if (/\.(?:php|phtml)$/i.test(normalized) && typeof content === 'string' && /<(?:html|body|main|form|button|nav|section|div)\b/i.test(content)) return true;
  return SCRIPT_FILE.test(normalized) && typeof content === "string" && GUI_CONTENT.test(content.slice(0, 24000));
}

/** Combine the heuristic reading with the judge's verdict. Pure. */
export function resolveUiWork(cue: UiCue, verdict: TypedVerdict | undefined): boolean {
  if (cue.strength === "none") return false;
  const supported = verdict?.ok ? (verdict.verdict as { supported?: boolean } | undefined)?.supported : undefined;
  if (supported !== undefined) return supported;
  // Jev unavailable or unsure: strong vocabulary still counts, weak does not.
  return cue.strength === "strong";
}
