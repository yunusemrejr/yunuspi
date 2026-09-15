// intervention-intents — canonical shadow-intent builders, one per wired
// subsystem. Each builder returns a VALID InterventionIntent input (sans
// requestId, which the session supplies): every builder output must survive
// control validation, pinned by the shadow suite. Subsystem call sites stay
// one line: shadowPlane.shadow(guidanceHintIntent(hint)).
//
// Pure and additive: no pi imports, no I/O.
import { createHash } from "node:crypto";
import type { InterventionIntent } from "./intervention-control.ts";

export type ShadowIntentInput = Omit<InterventionIntent, "requestId" | "createdAt" | "id">;

const SHADOW_TTL_MS = 60_000;

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 64);
}

function clampPriority(priority: unknown): number {
  return typeof priority === "number" && Number.isFinite(priority)
    ? Math.max(0, Math.min(100, priority))
    : 0;
}

/** One queued guidance hint (relevant-guidance.ts add()). */
export function guidanceHintIntent(hint: { key?: unknown; text?: unknown; priority?: unknown }): ShadowIntentInput {
  const key = String((typeof hint.key === "string" && hint.key) || "hint");
  const text = typeof hint.text === "string" ? hint.text : "";
  return {
    source: "relevant-guidance.ts",
    category: "guidance",
    priority: clampPriority(hint.priority),
    reason: `guidance hint queued: ${key}`.slice(0, 500),
    stabilityKey: key.slice(0, 160),
    contentHash: contentHash(text || key),
    ttlMs: SHADOW_TTL_MS,
    estimatedChars: text.length,
    estimatedCost: 0,
    blocking: false,
    evidence: [],
  };
}

/** Project-intelligence system-prompt guidance (before_agent_start). */
export function intelSystemGuidanceIntent(guidance: unknown): ShadowIntentInput {
  const text = typeof guidance === "string" ? guidance : "";
  return {
    source: "project-intelligence.ts",
    category: "context",
    priority: 50,
    reason: "project-intelligence system-prompt guidance",
    stabilityKey: "intel-system-guidance",
    contentHash: contentHash(text),
    ttlMs: SHADOW_TTL_MS,
    estimatedChars: text.length,
    estimatedCost: 0,
    blocking: false,
    evidence: [],
  };
}

/** Project-intelligence context-capsule injection (context event). */
export function intelContextCapsuleIntent(capsule: unknown, scopeBrief: unknown): ShadowIntentInput {
  const capsuleText = typeof capsule === "string" ? capsule : "";
  const briefText = typeof scopeBrief === "string" ? scopeBrief : "";
  return {
    source: "project-intelligence.ts",
    category: "context",
    priority: 50,
    reason: "project-intelligence context capsule",
    stabilityKey: "intel-context-capsule",
    contentHash: contentHash(`${capsuleText}\n\n${briefText}`),
    ttlMs: SHADOW_TTL_MS,
    estimatedChars: capsuleText.length + briefText.length,
    estimatedCost: 0,
    blocking: false,
    evidence: [],
  };
}
