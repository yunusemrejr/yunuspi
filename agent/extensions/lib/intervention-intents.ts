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

/** Quality-review round launch (explicit or automatic). */
export function reviewRoundIntent(input: {
  revision?: unknown; round?: unknown; automatic?: unknown; files?: unknown; task?: unknown;
}): ShadowIntentInput {
  const revision = typeof input.revision === "number" && Number.isFinite(input.revision) ? Math.max(0, Math.floor(input.revision)) : 0;
  const round = typeof input.round === "number" && Number.isFinite(input.round) ? Math.max(0, Math.floor(input.round)) : 0;
  const task = typeof input.task === "string" ? input.task.slice(0, 500) : "";
  return {
    source: "quality-review.ts",
    category: "review",
    priority: input.automatic === true ? 40 : 60,
    reason: `quality-review round ${round} on revision ${revision}${input.automatic === true ? " (automatic)" : ""}`,
    stabilityKey: `review:rev${revision}:round${round}`,
    contentHash: contentHash(`${revision}:${round}:${task}`),
    ttlMs: SHADOW_TTL_MS,
    estimatedChars: 0,
    estimatedCost: 0,
    blocking: false,
    evidence: [],
  };
}

/** Checkpoint-history context injection (post-compaction navigation). */
export function checkpointHistoryIntent(input: { missing?: unknown; content?: unknown }): ShadowIntentInput {
  const missing = typeof input.missing === "number" && Number.isFinite(input.missing) ? Math.max(0, Math.floor(input.missing)) : 0;
  const content = typeof input.content === "string" ? input.content : "";
  return {
    source: "checkpoints.ts",
    category: "checkpoint",
    priority: 50,
    reason: `checkpoint history navigation for ${missing} missing message(s)`,
    stabilityKey: "checkpoint-history",
    contentHash: contentHash(content || String(missing)),
    ttlMs: SHADOW_TTL_MS,
    estimatedChars: content.length,
    estimatedCost: 0,
    blocking: false,
    evidence: [],
  };
}

/** Subagent child launch (foreground + background runners). Every launch is
 *  a distinct effect, so the stability key is per-launch (run + step), never
 *  content-based: two identical fans must not dedup each other at go-live. */
export function assistanceLaunchIntent(input: {
  agent?: unknown; task?: unknown; model?: unknown; runId?: unknown; stepIndex?: unknown; mode?: unknown;
}): ShadowIntentInput {
  const agent = typeof input.agent === "string" && input.agent ? input.agent.slice(0, 80) : "child";
  const task = typeof input.task === "string" ? input.task.slice(0, 500) : "";
  const model = typeof input.model === "string" && input.model ? input.model.slice(0, 160) : "default";
  const runId = typeof input.runId === "string" && input.runId ? input.runId.slice(0, 80) : "run";
  const step = typeof input.stepIndex === "number" && Number.isFinite(input.stepIndex) ? Math.max(0, Math.floor(input.stepIndex)) : 0;
  const mode = input.mode === "async" ? "async" : "foreground";
  return {
    source: "pi-subagents.ts",
    category: "assistance",
    priority: 50,
    reason: `subagent launch: ${agent} on ${model} (${mode})`.slice(0, 500),
    stabilityKey: `assist:${runId}:${step}`.slice(0, 160),
    contentHash: contentHash(`${agent}\n${task}\n${model}`),
    ttlMs: SHADOW_TTL_MS,
    estimatedChars: 0,
    // Launch cost is unknown before inference; the helper-count envelope
    // is the binding one. Zero here is honest, not free.
    estimatedCost: 0,
    blocking: false,
    evidence: [{ kind: "run", id: runId }],
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
