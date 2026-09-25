/**
 * context_profile — native context-cost diagnostics for the running session.
 *
 * The probe hashes the provider-visible message array from the final request
 * payload when available (falling back to the context hook for providers with
 * non-array prompts). This keeps display-only or filtered context entries from
 * being misattributed as cache-prefix breaks. A prefix break names its owner
 * as `custom:<customType>`, a tool, or a role, and each request is finalized
 * with the provider's own usage counters from the assistant message.
 *
 * State lives in `logs/context-profile/` (runtime state, never exported) and
 * contains hashes, roles and counts only — no prompt text, no tool output.
 * Records are a bounded ring; a very long session caps stored digests.
 */
import { getAgentDir } from "@yunuspi/coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  appendRecord,
  buildRecord,
  changeKey,
  compareEnvelope,
  compositionFromBranch,
  DEFAULT_RING,
  isPrefixBreak,
  payloadEnvelope,
  payloadMessages,
  prefixSummary,
  PROFILE_VERSION,
  selectProbeMessages,
} from "./lib/context-profile.mjs";

const MAX_STATE_CHARS = 512 * 1024;
const MAX_VIEW = 50;

type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

type SessionState = {
  v: number;
  session: string;
  updatedAt: string;
  seq: number;
  lastAt: number | null;
  digests: unknown[];
  records: any[];
  totals: Usage & {
    requests: number;
    breaks: number;
    envelopeBreaks: number;
    resentChars: number;
  };
  /** Previous request envelope summary (hashes only) and the tool array it was
   * computed from. Tools stay in memory: they explain the next divergence and
   * are far too large to persist per request. */
  envelope?: any;
  tools?: unknown[] | null;
  pending?: unknown[] | null;
};

const sessions = new Map<string, SessionState>();
let stateDirCache: string | null = null;

function stateDir(): string {
  return (stateDirCache ??=
    process.env.PI_CONTEXT_PROFILE_DIR ||
    path.join(getAgentDir(), "logs", "context-profile"));
}

function sessionId(ctx: any): string | null {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

function stateFile(id: string): string {
  return path.join(
    stateDir(),
    `${id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120)}.json`,
  );
}

function emptyState(id: string): SessionState {
  return {
    v: PROFILE_VERSION,
    session: id,
    updatedAt: new Date(0).toISOString(),
    seq: 0,
    lastAt: null,
    digests: [],
    records: [],
    totals: {
      requests: 0,
      breaks: 0,
      envelopeBreaks: 0,
      resentChars: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    envelope: undefined,
    tools: null,
    pending: null,
  };
}

function getState(id: string): SessionState {
  const existing = sessions.get(id);
  if (existing) return existing;
  let state = emptyState(id);
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(id), "utf8"));
    if (parsed?.v === PROFILE_VERSION && Array.isArray(parsed.records)) {
      state = { ...state, ...parsed, pending: null };
      normalizeState(state, id);
    }
  } catch {
    // First run or unreadable state: start a fresh bounded profile.
  }
  sessions.set(id, state);
  return state;
}

/** Disk state is untrusted: a corrupt file degrades to defaults field by
 * field instead of throwing in renderProfile or poisoning the ring. */
export function normalizeState(state: SessionState, id: string): void {
  if (typeof state.session !== "string" || !state.session) state.session = id;
  if (typeof state.updatedAt !== "string")
    state.updatedAt = new Date(0).toISOString();
  if (!Number.isSafeInteger(state.seq) || state.seq < 0) state.seq = 0;
  if (state.lastAt !== null && typeof state.lastAt !== "number")
    state.lastAt = null;
  if (!Array.isArray(state.digests)) state.digests = [];
  else state.digests = state.digests.slice(-1000);
  if (!Array.isArray(state.records)) state.records = [];
  else
    state.records = state.records
      .filter((record) => record && typeof record === "object")
      .slice(-DEFAULT_RING);
  const totals = (state.totals ?? {}) as Record<string, unknown>;
  state.totals = {
    requests: number(totals.requests),
    breaks: number(totals.breaks),
    envelopeBreaks: number(totals.envelopeBreaks),
    resentChars: number(totals.resentChars),
    input: number(totals.input),
    output: number(totals.output),
    cacheRead: number(totals.cacheRead),
    cacheWrite: number(totals.cacheWrite),
  };
  if (
    state.tools !== null &&
    state.tools !== undefined &&
    !Array.isArray(state.tools)
  )
    state.tools = null;
  if (
    state.pending !== null &&
    state.pending !== undefined &&
    !Array.isArray(state.pending)
  )
    state.pending = null;
}

function writeState(id: string, state: SessionState): void {
  try {
    // `pending` and the raw tool array are per-request memory, not state.
    const record = { ...state, pending: undefined, tools: undefined };
    let serialized = JSON.stringify(record);
    if (serialized.length > MAX_STATE_CHARS) {
      serialized = JSON.stringify({
        ...record,
        digests: state.digests.slice(-1000),
      });
    }
    fs.mkdirSync(stateDir(), { recursive: true });
    const file = stateFile(id);
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, serialized, { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch {
    // Diagnostics must never break a request because state cannot be written.
  }
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : 0;
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

/** Human-readable envelope attribution for one record: which pre-message part
 * of the request changed (system prompt, tool list, request scalars). */
function envelopeNote(record: any): string {
  if (!record?.envelopeChanged) return "";
  const parts = (record.envelopeChanges ?? []).map((change: any) => {
    if (change?.component === "tools") {
      const names = [
        ...(change.added ?? []).map((name: string) => `+${name}`),
        ...(change.removed ?? []).map((name: string) => `-${name}`),
        ...(change.changed ?? []).map((name: string) => `~${name}`),
      ];
      return `tools ${change.previousCount}→${change.currentCount}${names.length ? ` (${names.slice(0, 6).join(", ")})` : ""}`;
    }
    if (change?.component === "systemPrompt")
      return `systemPrompt ${change.previousChars}→${change.currentChars} chars`;
    if (change?.component === "request-fields")
      return `request fields ${(change.keys ?? []).join(", ")}`;
    return String(change?.component ?? "envelope");
  });
  return ` | envelope changed: ${parts.join("; ")}`;
}

function recordRequest(
  ctx: any,
  wireMessages: unknown[] | null,
  payload: any = null,
): void {
  const id = sessionId(ctx);
  if (!id) return;
  const state = getState(id);
  // `pending` is the pre-provider context hook and may contain entries that
  // convertToLlm or a provider adapter filters. Prefer the final payload so
  // diagnostics describe the bytes that can actually affect provider caching.
  const messages = selectProbeMessages(wireMessages, state.pending);
  if (!Array.isArray(messages) || messages.length === 0) return;
  const now = Date.now();
  // The envelope (system prompt, tool list, request scalars) sits in front of
  // every message, so a change there invalidates the whole conversation even
  // when the message tail appended cleanly. Attribute it separately.
  const envelope = payloadEnvelope(payload);
  const envelopeChanges = envelope
    ? compareEnvelope(state.envelope, envelope, state.tools, payload?.tools)
    : null;
  const { record, digests } = buildRecord({
    seq: state.seq + 1,
    at: now,
    msSincePrev: state.lastAt === null ? null : now - state.lastAt,
    messages,
    previousDigests: state.digests,
    baseline: state.seq === 0,
    envelopeChanges,
  });
  state.seq += 1;
  state.lastAt = now;
  state.digests = digests;
  state.records = appendRecord(state.records, record, DEFAULT_RING);
  state.totals.requests += 1;
  if (isPrefixBreak(record)) state.totals.breaks += 1;
  if (record.envelopeChanged) state.totals.envelopeBreaks += 1;
  state.totals.resentChars += record.resentChars;
  if (envelope) {
    state.envelope = envelope;
    state.tools = payload?.tools ?? payload?.functions ?? null;
  }
  state.pending = null;
  state.updatedAt = new Date(now).toISOString();
  writeState(id, state);
}

function renderProfile(
  state: SessionState,
  branch: any[],
  limit: number,
): { text: string; details: Record<string, unknown> } {
  const records = state.records.slice(-limit);
  const summary = prefixSummary(records);
  const composition = compositionFromBranch(branch);
  const totals = state.totals;
  const prompt = totals.input + totals.cacheRead + totals.cacheWrite;
  const branchChars = composition.reduce((sum, row) => sum + row.chars, 0);
  const breaks = records.filter(isPrefixBreak);
  const lines: string[] = [];
  lines.push(
    `context_profile — session ${state.session.slice(0, 24)} | ${state.totals.requests} recorded request(s), ${state.records.length}/${DEFAULT_RING} in ring`,
  );
  lines.push(
    `prefix: ${summary.requests} shown | ${summary.breaks} break(s)${summary.envelopeBreaks ? ` (${summary.envelopeBreaks} envelope)` : ""} | est. re-sent ${formatCount(summary.resentChars)} chars (~${formatCount(Math.ceil(summary.resentChars / 4))} tokens)`,
  );
  if (prompt > 0) {
    lines.push(
      `cache: input ${formatCount(totals.input)} | cacheRead ${formatCount(totals.cacheRead)} | cacheWrite ${formatCount(totals.cacheWrite)} | hit ${((100 * totals.cacheRead) / prompt).toFixed(1)}%`,
    );
  }
  if (summary.breaks === 0) {
    lines.push(
      state.records.length
        ? "prefix: stable across recorded requests — no attributed first divergence yet."
        : "prefix: no provider request recorded yet in this process.",
    );
  } else {
    lines.push("breaks (latest first):");
    for (const record of [...breaks].reverse()) {
      const usage = record.usage
        ? ` | cacheRead ${formatCount(record.usage.cacheRead)} input ${formatCount(record.usage.input)}`
        : "";
      const gap =
        record.msSincePrev !== null
          ? ` | ${(record.msSincePrev / 1000).toFixed(1)}s since previous`
          : "";
      lines.push(
        `  #${record.seq} ${record.appendedOnly && !record.envelopeChanged ? "append" : "break"} ${record.firstChange ? changeKey(record.firstChange) : "envelope"} lcp ${record.lcpIndex}/${record.messages} (${Math.round(record.lcpRatio * 100)}%) → est. ${formatCount(record.resentChars)} chars${usage}${gap}${record.digestsCapped ? " | digests capped" : ""}${envelopeNote(record)}`,
      );
    }
  }
  if (summary.offenders.length) {
    lines.push("top attributed offenders:");
    for (const row of summary.offenders)
      lines.push(
        `  ${row.key} — ${row.breaks} break(s), est. ${formatCount(row.resentChars)} chars re-sent`,
      );
  }
  lines.push(
    `composition (${branch.length} branch entries, ${formatCount(branchChars)} chars):`,
  );
  for (const row of composition.slice(0, 12))
    lines.push(
      `  ${row.key} — ${row.count} entr${row.count === 1 ? "y" : "ies"}, ${formatCount(row.chars)} chars`,
    );
  lines.push(
    "Estimates use 4 chars/token; provider cache behaviour comes from recorded usage counters, not from hash guesses. State stores hashes and counts only.",
  );
  return {
    text: lines.join("\n"),
    details: {
      summary,
      composition,
      totals,
      records: records.length,
      ring: DEFAULT_RING,
      version: PROFILE_VERSION,
    },
  };
}

export default function contextProfileExtension(pi: any) {
  pi.on("context", (event: any, ctx: any) => {
    const id = sessionId(ctx);
    if (!id) return;
    const state = getState(id);
    state.pending = Array.isArray(event?.messages) ? event.messages : null;
    return undefined;
  });

  pi.on("before_provider_request", (event: any, ctx: any) => {
    recordRequest(ctx, payloadMessages(event?.payload), event?.payload ?? null);
    return undefined;
  });

  pi.on("message_end", (event: any, ctx: any) => {
    const message = event?.message;
    if (message?.role !== "assistant" || !message.usage) return;
    const id = sessionId(ctx);
    if (!id) return;
    const state = sessions.get(id);
    if (!state) return;
    const record = state.records[state.records.length - 1];
    if (!record || record.usage) return;
    record.usage = {
      input: number(message.usage.input),
      output: number(message.usage.output),
      cacheRead: number(message.usage.cacheRead),
      cacheWrite: number(message.usage.cacheWrite),
    };
    state.totals.input += record.usage.input;
    state.totals.output += record.usage.output;
    state.totals.cacheRead += record.usage.cacheRead;
    state.totals.cacheWrite += record.usage.cacheWrite;
    writeState(id, state);
  });

  pi.registerTool({
    name: "context_profile",
    label: "Context Profile",
    description:
      "Native context-cost diagnostics for this session: context composition by owner (custom injections, tools, roles), cached vs uncached input from provider usage, prefix-hash/divergence history with the first changed message attributed to its owner, pre-message envelope attribution (changed system prompt, added/removed/changed tool schemas such as tool_search activation, changed request scalars), tool-output mass, and estimated invalidation waste. Read-only; stores hashes and counts only, never prompt text.",
    promptSnippet:
      "Inspect context composition, cache counters and prefix-break attribution",
    promptGuidelines: [
      "Use context_profile before attributing context cost or cache misses to a guess: it reports cached vs uncached input, prefix divergences with the owning injection/tool, composition mass, and estimated re-sent tokens for this session.",
    ],
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_VIEW,
          description: `How many recent requests to show (default 12, max ${MAX_VIEW})`,
        }),
      ),
    }),
    async execute(
      _id: any,
      params: { limit?: number },
      _signal: AbortSignal,
      _update: any,
      ctx: any,
    ) {
      const id = sessionId(ctx);
      const state = id ? getState(id) : null;
      let branch: any[] = [];
      try {
        branch = ctx?.sessionManager?.getBranch?.() ?? [];
      } catch {
        branch = [];
      }
      if (!state)
        return {
          content: [
            {
              type: "text" as const,
              text: "context_profile: no session identity available; run this tool in an interactive session.",
            },
          ],
        };
      const { text, details } = renderProfile(
        state,
        branch,
        Math.min(params.limit ?? 12, MAX_VIEW),
      );
      return { content: [{ type: "text" as const, text }], details };
    },
  });
}
