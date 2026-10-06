/** UI-work detection and optional design guidance.
 *
 * WHY: models asked for an interface with no constraints converge on the same
 * two looks (indigo/purple SaaS, cream/terracotta editorial). The harness
 * embeds `design-slop-prevention` as a skill; this module decides WHEN an agent
 * is doing interface work and offers that reference when useful.
 *
 * Who decides: deterministic cues frame the question (a UI file being written,
 * UI vocabulary in the request). Jev then settles the ambiguous middle in both
 * directions — "page fault" is not a web page, "make checkout less confusing"
 * is UI work with no UI word — through the typed `ui-work` decision, at
 * roughly 300 input tokens instead of a model turn. Jev unavailable or unsure
 * keeps the heuristic (strong cues count, weak cues do not); Jev refines, it
 * never gates. Editing a UI file is deterministic and needs no judge.
 *
 * Advice is bounded and never blocks a tool or requires a skill read. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { askTypedDecision, type TypedVerdict } from "./micro-intelligence/jev-decisions.ts";
import type { JudgeFn } from "./micro-intelligence/review.ts";

export const UI_DOCTRINE_SKILL = "design-slop-prevention";
export const UI_DOCTRINE_CONTEXT = "ui-doctrine-context";

const STRONG_PROMPT = /\b(?:ui|ux|gui|user interfaces?|front-?end|web ?sites?|landing ?pages?|home ?pages?|web ?apps?|dashboards?|mock-?ups?|wireframes?|css|tailwind|style ?sheets?|design systems?|hero sections?|nav ?bars?|side ?bars?|modals?|re-?design|re-?style|figma|storefronts?|portfolio sites?|responsive (?:design|layout)|color palettes?|typography|onboarding flow|checkout flow|sign-?up (?:page|flow|form)|login (?:page|screen|form))\b/i;
const WEAK_PROMPT = /\b(?:pages?|layouts?|styles?|styling|screens?|looks?|feels?|buttons?|forms?|themes?|colou?rs?|fonts?|components?|visuals?|designs?|apps?|sites?|interfaces?|widgets?|menus?|animations?|confusing|clunky|ugly|clean(?:er)?|modern|polish(?:ed)?)\b/i;
/** Prose about a subject, not work on it; a question is not an interface task. */
const NARRATIVE = /^\s*(?:what|who|when|where|why|how)\s+(?:is|are|was|were|does|do|did|would|should|can|could)\b|\b(?:explain|describe|summari[sz]e)\b/i;
const NO_UI = /\b(?:no|without|skip)\s+(?:ui|frontend|front-end|gui)\b|\b(?:backend|back-end|cli|api)[- ]only\b|\bheadless\b/i;
const WORK_VERB = /\b(?:add|build|create|design|implement|make|redesign|restyle|fix|improve|change|update|polish|refactor|develop|craft|revamp|rework|tweak|adjust|style|prototype|generate|write)\b/i;

const UI_FILE = /\.(?:html?|css|scss|sass|less|jsx|tsx|vue|svelte|astro|xaml|qml)$/i;
const EXCLUDED_PATH = /(?:^|\/)(?:node_modules|vendor|dist|build|coverage|fixtures?|__fixtures__|__snapshots__|skills|references|backups)\/|\.(?:min|generated|test|spec|stories)\.|(?:^|\/)(?:SKILL|README|CHANGELOG)\.md$/i;
const SCRIPT_FILE = /\.(?:[cm]?[jt]s|py|rs|kt|swift|dart|java|cs|lua)$/i;
/** GUI toolkits and DOM builders: a script that draws windows or markup is interface work. */
const GUI_CONTENT = /\b(?:tkinter|customtkinter|PyQt\d|PySide\d|kivy|wx\.Frame|Gtk\.\w+|QWidget|JFrame|javafx|SwiftUI|@Composable|package:flutter\/|egui::|document\.createElement|\.innerHTML\s*=|React\.createElement)\b/;

export type UiCue = { strength: "none" | "weak" | "strong"; terms: string[] };

/** Deterministic first reading of a request. `none` never reaches the judge. */
export function uiPromptCue(prompt: string): UiCue {
  const text = typeof prompt === "string" ? prompt.slice(0, 6000) : "";
  if (!text.trim() || NARRATIVE.test(text) || NO_UI.test(text) || !WORK_VERB.test(text)) return { strength: "none", terms: [] };
  const strong = [...text.matchAll(new RegExp(STRONG_PROMPT.source, "gi"))].map((m) => m[0].toLowerCase());
  if (strong.length) return { strength: "strong", terms: [...new Set(strong)].slice(0, 6) };
  const weak = [...text.matchAll(new RegExp(WEAK_PROMPT.source, "gi"))].map((m) => m[0].toLowerCase());
  return weak.length ? { strength: "weak", terms: [...new Set(weak)].slice(0, 6) } : { strength: "none", terms: [] };
}

/** A written file is interface work by extension, or by GUI markers in what is written. */
export function uiFileCue(file: string, content?: string): boolean {
  const normalized = String(file ?? "").replaceAll("\\", "/");
  if (!normalized || EXCLUDED_PATH.test(normalized)) return false;
  if (UI_FILE.test(normalized)) return true;
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

/** Installed location of the embedded skill. Subagents launched without a skill
 * catalog have no other way to learn the path, and the file ships with the harness. */
export function installedDoctrineFile(agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")): string | undefined {
  const file = join(agentDir, "skills", UI_DOCTRINE_SKILL, "SKILL.md");
  try { return existsSync(file) ? file : undefined; } catch { return undefined; }
}

export interface UiDoctrineDeps {
  /** Absolute path of the doctrine skill in this run's catalog, if listed there. */
  skillFile: () => string | undefined;
  isRead: (file: string) => boolean;
  judge?: JudgeFn;
  /** Called once when a request becomes interface work, e.g. to queue a hint. */
  onActive?: (reason: string) => void;
}

export function createUiDoctrine(deps: UiDoctrineDeps) {
  let active = "";
  let epoch = 0;
  let controller: AbortController | undefined;
  // Read receipts for the fallback path, which the skill catalog does not track.
  const readHere = new Set<string>();
  const doctrineFile = () => deps.skillFile() ?? installedDoctrineFile();

  const activate = (reason: string) => {
    if (active) return;
    active = reason;
    try { deps.onActive?.(reason); } catch { /* advice must never break the turn */ }
  };
  const unread = () => {
    const file = doctrineFile();
    return file && !deps.isRead(file) && !readHere.has(file) ? file : undefined;
  };

  return {
    /** New request: reset, read the prompt heuristically, then let Jev settle it without blocking the turn. */
    observePrompt(prompt: string, options: { keep?: boolean } = {}) {
      controller?.abort();
      controller = undefined;
      epoch++;
      if (!options.keep) active = "";
      const cue = uiPromptCue(prompt);
      if (cue.strength === "none" || active) return;
      const mine = epoch;
      const named = `request names interface work (${cue.terms.join(", ")})`;
      if (!deps.judge) { if (cue.strength === "strong") activate(named); return; }
      controller = new AbortController();
      const { signal } = controller;
      void askTypedDecision("ui-work", { state: { request: prompt.slice(0, 1500), cues: cue.terms.join(", ") } }, { judge: deps.judge, signal })
        .then((verdict) => {
          if (mine !== epoch || signal.aborted) return;
          if (resolveUiWork(cue, verdict)) activate(verdict.ok ? "Jev judged the request to be interface work" : named);
        })
        .catch(() => { if (mine === epoch && cue.strength === "strong") activate(named); });
    },
    /** A successful native read clears the optional reference hint. */
    noteRead(file: string) {
      if (file && file === doctrineFile()) readHere.add(file);
    },
    /** Deterministic: the agent is writing interface code. */
    observeFile(file: string, content?: string) {
      if (uiFileCue(file, content)) activate("a user-interface file is being written");
    },
    /** Text kept on the wire while interface work is active and the skill unread. */
    contextText(): string | undefined {
      const file = active && unread();
      if (!file) return undefined;
      return `[UI reference: optional]\nThis task involves interface or UX work (${active}). Consult ${JSON.stringify(file)} if useful for palette, typography, layout or copy. Adapt its guidance to the user's style and actual project. Use rendering and interaction tools to assess the result; reading a guide does not establish visual quality. Work can proceed without this read.`;
    },
    isActive: () => Boolean(active),
    cancel() { controller?.abort(); controller = undefined; epoch++; },
    /** Session boundary: nothing carries over to another session's request. */
    reset() { controller?.abort(); controller = undefined; epoch++; active = ""; },
  };
}
