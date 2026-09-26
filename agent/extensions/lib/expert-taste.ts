/**
 * Expert taste memory — persistent, non-dogmatic quality preferences.
 * Store schema plus pure fold/render policy; file persistence mirrors the
 * reminders-state atomic-write contract. This store is deliberately
 * separate from factual project memory: preferences are priors with
 * provenance and confidence, updated by later evidence, never rules.
 *
 * WHY: "restrained visuals", "explicit state machines" or "concise prose"
 * recur across sessions but do not belong in factual recall. Preferences
 * enter only from explicit user direction or repeated accepted/rejected
 * outcomes with recorded provenance; a single rejection never becomes a
 * ban, and later evidence revises confidence instead of arguing.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExpertDomainId } from "./expert-domains.ts";

export type TasteScope = "user" | "project";
export type TasteProvenance = "explicit" | "accepted" | "rejected";

export interface TastePreference {
  id: string;
  scope: TasteScope;
  /** Project identity for project scope, "" for user scope. */
  project: string;
  /** Domain ids this preference applies to; empty means all domains. */
  domains: ExpertDomainId[];
  /** One observable preference statement, ≤200 chars. */
  text: string;
  provenance: TasteProvenance;
  /** 0..1: explicit direction starts high, outcomes accumulate slowly. */
  confidence: number;
  /** Accept/reject observations behind this preference. */
  confirmations: number;
  contradictions: number;
  updatedAt: number;
}

export interface TasteStore {
  version: 1;
  preferences: TastePreference[];
}

export const TASTE_STORE_VERSION = 1;
const MAX_PREFERENCES = 64;
const MAX_TEXT_CHARS = 200;

export function emptyTasteStore(): TasteStore {
  return { version: TASTE_STORE_VERSION, preferences: [] };
}

export function tasteStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = typeof env.PI_EXPERT_DIR === "string" && env.PI_EXPERT_DIR ? env.PI_EXPERT_DIR : "";
  return override || path.join(os.homedir(), ".pi", "expert");
}

export function tasteStoreFile(scope: TasteScope, project: string, env: NodeJS.ProcessEnv = process.env): string {
  const safe = scope === "project" ? project.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64) || "project" : "user";
  return path.join(tasteStoreDir(env), `taste-${safe}.json`);
}

function sanitizePreference(raw: unknown): TastePreference | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;
  if (p.scope !== "user" && p.scope !== "project") return undefined;
  if (typeof p.text !== "string" || !p.text.trim()) return undefined;
  if (p.provenance !== "explicit" && p.provenance !== "accepted" && p.provenance !== "rejected") return undefined;
  const confidence = typeof p.confidence === "number" && Number.isFinite(p.confidence)
    ? Math.max(0, Math.min(1, p.confidence)) : 0;
  return {
    id: typeof p.id === "string" && p.id ? p.id.slice(0, 64) : randomUUID(),
    scope: p.scope,
    project: p.scope === "project" && typeof p.project === "string" ? p.project.slice(0, 128) : "",
    domains: Array.isArray(p.domains) ? p.domains.filter((d): d is ExpertDomainId => typeof d === "string").slice(0, 8) : [],
    text: p.text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS),
    provenance: p.provenance,
    confidence,
    confirmations: typeof p.confirmations === "number" && Number.isFinite(p.confirmations) ? Math.max(0, Math.floor(p.confirmations)) : 0,
    contradictions: typeof p.contradictions === "number" && Number.isFinite(p.contradictions) ? Math.max(0, Math.floor(p.contradictions)) : 0,
    updatedAt: typeof p.updatedAt === "number" && Number.isFinite(p.updatedAt) ? p.updatedAt : Date.now(),
  };
}

export function readTasteStore(scope: TasteScope, project = "", env: NodeJS.ProcessEnv = process.env): TasteStore {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(tasteStoreFile(scope, project, env), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return emptyTasteStore();
    const prefs = Array.isArray((raw as TasteStore).preferences) ? (raw as TasteStore).preferences : [];
    return {
      version: TASTE_STORE_VERSION,
      preferences: prefs.map(sanitizePreference).filter((p): p is TastePreference => !!p).slice(0, MAX_PREFERENCES),
    };
  } catch {
    return emptyTasteStore();
  }
}

export function writeTasteStore(scope: TasteScope, project: string, store: TasteStore, env: NodeJS.ProcessEnv = process.env): boolean {
  let tmp: string | undefined;
  try {
    fs.mkdirSync(tasteStoreDir(env), { recursive: true, mode: 0o700 });
    tmp = `${tasteStoreFile(scope, project, env)}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: TASTE_STORE_VERSION, preferences: store.preferences.slice(0, MAX_PREFERENCES) }), { flag: "wx", mode: 0o600 });
    fs.renameSync(tmp, tasteStoreFile(scope, project, env));
    tmp = undefined;
    return true;
  } catch (error) {
    console.error("[expert-taste] store write failed:", error instanceof Error ? error.message : String(error));
    return false;
  } finally {
    if (tmp) try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

export interface TasteSignal {
  scope: TasteScope;
  project?: string;
  domains?: readonly ExpertDomainId[];
  text: string;
  provenance: TasteProvenance;
}

const sameText = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Fold one preference signal into the store. Explicit direction records
 * immediately at high confidence; outcome signals need repetition (two
 * agreeing observations) before they count as a prior, and a single
 * contradiction only lowers confidence instead of deleting. */
export function foldTastePreference(store: TasteStore, signal: TasteSignal): { store: TasteStore; preference: TastePreference } {
  const text = String(signal.text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
  const scope = signal.scope === "project" ? "project" : "user";
  const project = scope === "project" ? String(signal.project ?? "").slice(0, 128) : "";
  const domains = [...new Set((signal.domains ?? []).filter((d) => typeof d === "string"))].slice(0, 8);
  const existing = store.preferences.find((p) => p.scope === scope && p.project === project && sameText(p.text, text)
    && (p.provenance === signal.provenance || signal.provenance === "explicit"));
  if (signal.provenance === "explicit") {
    if (existing) {
      const preference: TastePreference = { ...existing, domains: domains.length ? domains : existing.domains, confidence: 0.9, updatedAt: Date.now() };
      return { store: replace(store, preference), preference };
    }
    const preference: TastePreference = {
      id: randomUUID(), scope, project, domains, text, provenance: "explicit",
      confidence: 0.9, confirmations: 1, contradictions: 0, updatedAt: Date.now(),
    };
    return { store: push(store, preference), preference };
  }
  // Outcome-derived: accumulate; promote to a prior after two agreements.
  if (existing) {
    const confirmations = existing.confirmations + 1;
    const confidence = Math.min(0.75, 0.3 + confirmations * 0.15);
    const preference: TastePreference = { ...existing, domains: mergeDomains(existing.domains, domains), confidence, confirmations, updatedAt: Date.now() };
    return { store: replace(store, preference), preference };
  }
  const lone = store.preferences.find((p) => p.scope === scope && p.project === project && sameText(p.text, text));
  if (lone && lone.provenance !== signal.provenance) {
    // A rejected outcome contradicting an accepted prior (or vice versa)
    // lowers confidence; it does not delete the record.
    const contradictions = lone.contradictions + 1;
    const preference: TastePreference = { ...lone, confidence: Math.max(0.1, lone.confidence - 0.2), contradictions, updatedAt: Date.now() };
    return { store: replace(store, preference), preference };
  }
  const preference: TastePreference = {
    id: randomUUID(), scope, project, domains, text, provenance: signal.provenance,
    confidence: 0.3, confirmations: 1, contradictions: 0, updatedAt: Date.now(),
  };
  return { store: push(store, preference), preference };
}

function replace(store: TasteStore, preference: TastePreference): TasteStore {
  return { version: TASTE_STORE_VERSION, preferences: store.preferences.map((p) => p.id === preference.id ? preference : p) };
}

function push(store: TasteStore, preference: TastePreference): TasteStore {
  return { version: TASTE_STORE_VERSION, preferences: [...store.preferences, preference].slice(-MAX_PREFERENCES) };
}

function mergeDomains(a: readonly ExpertDomainId[], b: readonly ExpertDomainId[]): ExpertDomainId[] {
  if (!a.length || !b.length) return [...a, ...b].slice(0, 8);
  return [...new Set([...a, ...b])].slice(0, 8);
}

/** Recall applicable priors: project scope first, then user scope; global
 * (domain-empty) entries apply everywhere. Sorted by confidence. */
export function recallTaste(
  user: TasteStore, project: TasteStore, projectId: string, domains: readonly ExpertDomainId[], limit = 6,
): TastePreference[] {
  const matches = (p: TastePreference) =>
    (!domains.length || !p.domains.length || p.domains.some((d) => domains.includes(d))) && p.confidence >= 0.3;
  const scoped = project.preferences.filter((p) => p.project === projectId && matches(p));
  const global = user.preferences.filter(matches);
  const seen = new Set<string>();
  const out: TastePreference[] = [];
  for (const p of [...scoped, ...global].sort((a, b) => b.confidence - a.confidence)) {
    const key = p.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

/** Bounded context projection: priors, never rules. */
export function renderTasteContext(preferences: readonly TastePreference[]): string {
  if (!preferences.length) return "";
  const lines = preferences.slice(0, 6).map((p) =>
    `- ${p.text} (${p.scope}${p.domains.length ? `/${p.domains.join("+")}` : ""}, ${p.provenance}, ${(p.confidence).toFixed(1)})`);
  return `Quality priors from past direction (advisory; current user words win):\n${lines.join("\n")}`.slice(0, 1200);
}

/** Remove one preference by id prefix or exact text. Returns the removed entry. */
export function forgetTastePreference(store: TasteStore, selector: string): { store: TasteStore; removed?: TastePreference } {
  const needle = String(selector ?? "").trim().toLowerCase();
  if (!needle) return { store };
  const removed = store.preferences.find((p) => p.id.toLowerCase().startsWith(needle) || p.text.toLowerCase() === needle);
  if (!removed) return { store };
  return { store: { version: TASTE_STORE_VERSION, preferences: store.preferences.filter((p) => p.id !== removed.id) }, removed };
}
