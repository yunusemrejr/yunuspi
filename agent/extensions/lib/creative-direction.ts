/**
 * Creative Direction State — one structured brief owned by the task/project.
 *
 * WHY: UI, SVG, motion, image and audio guidance lives as prose scattered
 * across skills, so parallel subsystems drift apart (an understated editorial
 * page plus purple light leaks plus springy entrances). A single validated
 * direction gives every creative tool the same intent, hierarchy, visual
 * bounds, avoid-list, motion character and audio character to read; QA tools
 * (visual_review, ui_explore, motion_inspect) check conformance against it
 * and the completion gate refuses to close creative work with open findings.
 *
 * Pure policy plus small file helpers. The extension owns session state and
 * the continuation-source wiring; this module validates, normalizes, renders
 * the compact brief, and matches deterministic QA signals against avoid-lists.
 * Storage schema: `yunuspi-creative-direction-v1`.
 */

export const DIRECTION_FORMAT = "yunuspi-creative-direction-v1";
const MAX_ITEMS = 12;
const MAX_TEXT = 120;
const MAX_REFS = 8;

export interface CreativeHierarchy {
  primary: string;
  secondary?: string;
  tertiary?: string;
}

export interface CreativeVisual {
  density?: string;
  geometry?: string;
  depth?: string;
  texture?: string;
  illustration?: string;
}

export interface CreativeMotion {
  character?: string;
  intensity?: string;
  duration?: string;
  /** Whether continuous/decorative motion is acceptable. Default false. */
  continuous?: boolean;
}

export interface CreativeAudio {
  character?: string;
  music?: string;
  uiSfx?: string;
}

export interface CreativeDirection {
  format: typeof DIRECTION_FORMAT;
  name: string;
  intent: string[];
  hierarchy: CreativeHierarchy;
  visual: CreativeVisual;
  avoid: string[];
  motion: CreativeMotion;
  audio: CreativeAudio;
  references: string[];
  updatedAt: number;
}

const cleanText = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  return text || undefined;
};

const cleanList = (value: unknown, max = MAX_ITEMS): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    const text = cleanText(entry);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
};

const cleanRecord = <T extends object>(value: unknown, keys: (keyof T)[], bools: (keyof T)[] = []): T => {
  const out = {} as T;
  const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  for (const key of keys) {
    const text = cleanText(raw[key as string]);
    if (text !== undefined) (out as Record<string, unknown>)[key as string] = text;
  }
  for (const key of bools) {
    if (typeof raw[key as string] === "boolean") (out as Record<string, unknown>)[key as string] = raw[key as string];
  }
  return out;
};

/** Validate and normalize caller-supplied direction JSON. Unknown fields are
 * dropped so a stale brief never carries forward misspelled intent. Throws
 * on missing primary hierarchy: a direction without a focal decision is not
 * a direction. Pure. */
export function normalizeDirection(raw: unknown): CreativeDirection {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("direction must be an object with intent, hierarchy and avoid lists");
  const input = raw as Record<string, unknown>;
  const hierarchy = cleanRecord<CreativeHierarchy>(input.hierarchy, ["primary", "secondary", "tertiary"]);
  if (!hierarchy.primary) throw new Error("direction.hierarchy.primary is required (the one focal element, e.g. content, product, diagram)");
  const intent = cleanList(input.intent);
  if (!intent.length) throw new Error("direction.intent needs at least one term (e.g. serious, editorial, restrained)");
  return {
    format: DIRECTION_FORMAT,
    name: cleanText(input.name) ?? "untitled",
    intent,
    hierarchy,
    visual: cleanRecord<CreativeVisual>(input.visual, ["density", "geometry", "depth", "texture", "illustration"]),
    avoid: cleanList(input.avoid),
    motion: cleanRecord<CreativeMotion>(input.motion, ["character", "intensity", "duration"], ["continuous"]),
    audio: cleanRecord<CreativeAudio>(input.audio, ["character", "music", "uiSfx"]),
    references: cleanList(input.references, MAX_REFS),
    updatedAt: Date.now(),
  };
}

/** Compact context projection for prompts and QA tool calls. Bounded. */
export function renderDirectionBrief(direction: CreativeDirection, maxChars = 1600): string {
  const lines = [`Creative direction "${direction.name}" (advisory; user words win):`];
  lines.push(`- intent: ${direction.intent.join(", ")}`);
  const h = direction.hierarchy;
  lines.push(`- hierarchy: primary ${h.primary}${h.secondary ? `, secondary ${h.secondary}` : ""}${h.tertiary ? `, tertiary ${h.tertiary}` : ""}`);
  const visual = Object.entries(direction.visual).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join("; ");
  if (visual) lines.push(`- visual: ${visual}`);
  if (direction.avoid.length) lines.push(`- avoid: ${direction.avoid.join("; ")}`);
  const motion = Object.entries(direction.motion).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k} ${v}`).join("; ");
  if (motion) lines.push(`- motion: ${motion}`);
  const audio = Object.entries(direction.audio).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join("; ");
  if (audio) lines.push(`- audio: ${audio}`);
  if (direction.references.length) lines.push(`- references: ${direction.references.join(", ")}`);
  return lines.join("\n").slice(0, maxChars);
}

/** One-line TUI/ledger summary. */
export function directionSummary(direction: CreativeDirection): string {
  return `${direction.name}: ${direction.intent.slice(0, 4).join("/")} · focal ${direction.hierarchy.primary}${direction.avoid.length ? ` · avoid ${direction.avoid.length}` : ""}`;
}

export interface AvoidHit {
  avoid: string;
  signal: string;
}

const tokens = (text: string): string[] =>
  text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/[\s-]+/).filter((t) => t.length >= 3);

/** Match deterministic QA signals (noise findings, slop cues, audit notes)
 * against the direction avoid-list. A hit needs a shared vocabulary token,
 * so "neon glow" matches "decorative glow behind hero" but "glow" alone
 * never matches "glowing review copy". Pure. Signals are advisory pattern
 * names, not verdicts; the reviewer decides whether a hit is justified. */
export function matchAvoidSignals(direction: Pick<CreativeDirection, "avoid">, signals: readonly string[]): AvoidHit[] {
  const hits: AvoidHit[] = [];
  const seen = new Set<string>();
  for (const avoid of direction.avoid) {
    const avoidTokens = new Set(tokens(avoid));
    if (!avoidTokens.size) continue;
    for (const signal of signals) {
      if (typeof signal !== "string" || !signal) continue;
      const overlap = tokens(signal).some((t) => avoidTokens.has(t));
      if (!overlap) continue;
      const key = `${avoid}\0${signal.slice(0, 160)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ avoid, signal: signal.slice(0, 200) });
      if (hits.length >= 24) return hits;
    }
  }
  return hits;
}

/** Parse a stored direction file. Returns undefined for missing/corrupt
 * files so a damaged brief degrades to "no direction", never to invented
 * intent. Unknown fields are re-normalized, not trusted. */
export function parseDirectionFile(text: string): CreativeDirection | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== "object" || (raw as { format?: unknown }).format !== DIRECTION_FORMAT) return undefined;
    const direction = normalizeDirection(raw);
    const updatedAt = (raw as { updatedAt?: unknown }).updatedAt;
    if (typeof updatedAt === "number" && Number.isFinite(updatedAt)) direction.updatedAt = updatedAt;
    return direction;
  } catch {
    return undefined;
  }
}
