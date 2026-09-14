// Offline token-cost and cache diagnostics over session transcripts.
//
// WHY this exists: debugging "context/cost is rising" by reading individual
// sessions is slow and easy to misstate. The expensive quantity is not the
// cumulative character count a hook injects; it is the *uncached* input the
// provider re-bills when a prompt prefix stops matching its cache. This module
// measures that directly from the durable usage fields already stored on every
// assistant message, and keeps injection accounting out of the hot path.
//
// Accounting rules (deliberate, documented so results are not over-read):
//   * prompt tokens for a turn = input + cacheRead + cacheWrite.
//   * "new content tokens" is an ESTIMATE: characters since the previous
//     assistant message / 4, plus the previous assistant's output+reasoning.
//     It is a magnitude check, not a tokenizer.
//   * invalidation = cacheRead > 0 but input exceeds newContent by a threshold.
//     That means a cached prefix stopped matching and was re-sent at full price.
//   * noCacheTurn = cacheRead == 0 and cacheWrite == 0 on a non-trivial prompt;
//     the route simply did not cache (common on some free/OpenRouter routes),
//     which is separated from harness-visible invalidation on purpose.
//   * per-hook injected characters come from session-metrics-v1 entries, which
//     are CUMULATIVE within a segment. They are deduplicated by segment id
//     (max per segment) before summing, otherwise totals overcount ~100x.
//   * resume gaps (analyzeResumeGaps) attribute a cache miss across two
//     consecutive provider requests to provider-side expiry vs harness-side
//     mutation. The discriminator is the prompt-prefix identity: a stable hash
//     over message roles+content (usage, timestamps, provider, model and ids
//     excluded) plus the presence+size of injected custom blocks. An appended
//     trailing message preserves the prefix (providers cache the common
//     prefix), so growth alone is not a mutation. Same prefix + miss after a
//     long idle gap reads as provider-side TTL expiry; a changed prefix (or a
//     route change, or a compaction in between) reads as harness-side. Cache
//     age is supporting evidence, never ground truth about provider TTLs.
//
// Privacy: the scan returns counts, identifiers (tool/model names, file
// basenames) and dates only. It never returns message text or commands.
//
// Known limitations (do not over-read the numbers):
//   * `--since` filters on the session file's creation date. A resumed or
//     forked session can still contain inherited entries with older
//     timestamps, so `byDay` may show dates before `since`, and aggregated
//     totals can double-count usage inherited by forks.
//   * Provider routes without prompt caching report cacheRead == 0; those are
//     counted as no-cache turns, not as harness-visible invalidations.

import { createHash } from "node:crypto";

export const TOKEN_COST_LIMITS = Object.freeze({
  maxFiles: 4000,
  maxFileBytes: 64 * 1024 * 1024,
  maxEntriesPerFile: 200_000,
  minPromptTokens: 3000,
  minExcessTokens: 3000,
  charsPerToken: 4,
  topCount: 12,
  idleReferenceMs: 5 * 60 * 1000,
  maxResumeGaps: 50,
});

const LIVE_ROLES = new Set(["assistant", "user", "toolResult"]);
const BOUNDARY_CUSTOM_TYPES = new Set([
  "memory-prime",
  "reminders",
  "todo-plan",
  "siblings",
  "harness-maintenance-safety",
  "background-task-notification",
]);

const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);

/** Visible characters in a message body (text/thinking/tool-call arguments). */
export function messageChars(message) {
  const c = message?.content;
  if (typeof c === "string") return c.length;
  if (!Array.isArray(c)) return 0;
  let total = 0;
  for (const part of c) {
    if (!part || typeof part !== "object") continue;
    for (const key of ["text", "thinking"]) {
      if (typeof part[key] === "string") total += part[key].length;
    }
    if (part.type === "toolCall") {
      total += String(part.name ?? "").length;
      try {
        total += JSON.stringify(part.arguments ?? {}).length;
      } catch {
        /* unstringifiable arguments only lose that estimate */
      }
    }
  }
  return total;
}

function usageOf(message) {
  const u = message?.usage;
  if (!u || typeof u !== "object") return undefined;
  if (
    !Number.isFinite(u.input) &&
    !Number.isFinite(u.cacheRead) &&
    !Number.isFinite(u.output)
  )
    return undefined;
  return {
    input: num(u.input),
    cacheRead: num(u.cacheRead),
    cacheWrite: num(u.cacheWrite),
    output: num(u.output),
    reasoning: num(u.reasoning),
    totalTokens:
      num(u.totalTokens) || num(u.input) + num(u.cacheRead) + num(u.output),
  };
}

const routeOf = (message) => {
  const provider = message?.provider ?? message?.usage?.provider ?? "?";
  const model = message?.model ?? message?.usage?.model ?? "?";
  return `${provider} / ${model}`;
};

// ── resume-after-idle cache destruction ────────────────────────────────
// Bounds hashing per message so one pathological tool payload cannot dominate.
const RESUME_SEGMENT_LIMIT = 4096;

function resumeSegment(kind, body) {
  const text =
    typeof body === "string" ? body.slice(0, RESUME_SEGMENT_LIMIT) : "";
  return `${kind}:${createHash("sha256").update(text).digest("hex")}`;
}

/** One stable segment per message: role plus visible content only. */
function resumeMessageSegment(message) {
  const parts = [];
  const c = message?.content;
  if (typeof c === "string") parts.push(`text:${c}`);
  else if (Array.isArray(c)) {
    for (const part of c) {
      if (!part || typeof part !== "object") continue;
      if (typeof part.text === "string") parts.push(`text:${part.text}`);
      if (typeof part.thinking === "string")
        parts.push(`thinking:${part.thinking}`);
      if (part.type === "toolCall") {
        let args = "";
        try {
          args = JSON.stringify(part.arguments ?? {});
        } catch {
          /* unstringifiable arguments only lose that estimate */
        }
        parts.push(`toolCall:${part.name ?? ""}:${args}`);
      }
    }
  }
  return resumeSegment(`msg:${message?.role ?? "?"}`, parts.join("\n"));
}

/**
 * Attribute cache misses across consecutive provider requests to
 * provider-side expiry vs harness-side mutation. Pure; no I/O. Boundary
 * evidence carries custom entry TYPES (and injected-block sizes via the
 * prefix hash) only — never transcript text, tool arguments or commands.
 *
 * Returns { totals, gaps } where each gap is { turn, gapMs, prefixSame,
 * cacheBefore, cacheAfter, inputAfter, classification, boundary, route }.
 * Classifications: hit | cache-write | provider-expiry-likely |
 * harness-mutation | unexplained-miss | post-compaction.
 */
export function analyzeResumeGaps(entries, options = {}) {
  const limits = { ...TOKEN_COST_LIMITS, ...options };
  const totals = {
    resumeGaps: 0,
    providerExpiryLikely: 0,
    harnessMutationGaps: 0,
    unexplainedMissGaps: 0,
    postCompactionGaps: 0,
  };
  const gaps = [];
  let seq = [];
  let boundary = [];
  let sawCompaction = false;
  let injectedSincePrev = false;
  let prev = null;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type === "compaction") {
      sawCompaction = true;
      seq.push(resumeSegment("marker", "compaction"));
      boundary.push("compaction");
      continue;
    }
    if (entry.type === "custom_message") {
      boundary.push(String(entry.customType ?? "?"));
      if (BOUNDARY_CUSTOM_TYPES.has(entry.customType)) {
        // Injected blocks ride the next prompt: presence+size join the
        // prefix identity, text never leaves the transcript.
        const size =
          typeof entry.content === "string" ? entry.content.length : 0;
        seq.push(resumeSegment(`custom:${entry.customType}`, String(size)));
        injectedSincePrev = true;
      }
      continue;
    }
    if (entry.type === "custom") {
      boundary.push(`custom:${entry.customType ?? "?"}`);
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message || !LIVE_ROLES.has(message.role)) continue;
    seq.push(resumeMessageSegment(message));
    if (message.role !== "assistant") continue;
    const usage = usageOf(message);
    if (!usage) continue;
    const route = routeOf(message);
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    if (prev && promptTokens > limits.minPromptTokens) {
      const ts =
        typeof entry.timestamp === "string"
          ? Date.parse(entry.timestamp)
          : NaN;
      const gapMs =
        Number.isFinite(ts) && Number.isFinite(prev.ts) ? ts - prev.ts : null;
      // Append-only natural growth preserves the cached common prefix; a
      // divergent earlier segment or a harness-injected block between the
      // turns changes the prompt prefix bytes.
      const prefixSame =
        !injectedSincePrev && prev.seq.every((h, i) => seq[i] === h);
      const routeChanged = route !== prev.route;
      let classification;
      if (usage.cacheRead > 0) classification = "hit";
      else if (usage.cacheWrite > 0) classification = "cache-write";
      else if (sawCompaction) classification = "post-compaction";
      else if (routeChanged) classification = "harness-mutation";
      else if (!prefixSame) classification = "harness-mutation";
      else if (gapMs === null || gapMs < 0)
        classification = "unexplained-miss";
      else if (gapMs >= limits.idleReferenceMs)
        classification = "provider-expiry-likely";
      else classification = "unexplained-miss";
      const seen = new Set();
      const boundaryKinds = [
        ...(routeChanged ? [`route-change:${prev.route}->${route}`] : []),
        ...boundary,
      ].filter((b) => (seen.has(b) ? false : (seen.add(b), true)));
      totals.resumeGaps++;
      if (classification === "provider-expiry-likely")
        totals.providerExpiryLikely++;
      else if (classification === "harness-mutation")
        totals.harnessMutationGaps++;
      else if (classification === "unexplained-miss")
        totals.unexplainedMissGaps++;
      else if (classification === "post-compaction")
        totals.postCompactionGaps++;
      if (gaps.length < limits.maxResumeGaps) {
        gaps.push({
          turn: prev.turn + 1,
          gapMs,
          prefixSame,
          cacheBefore: prev.usage.cacheRead,
          cacheAfter: usage.cacheRead,
          inputAfter: usage.input,
          classification,
          boundary: boundaryKinds,
          route,
        });
      }
    }
    prev = {
      ts:
        typeof entry.timestamp === "string"
          ? Date.parse(entry.timestamp)
          : NaN,
      usage,
      route,
      turn: (prev?.turn ?? 0) + 1,
      seq: [...seq],
    };
    boundary = [];
    sawCompaction = false;
    injectedSincePrev = false;
  }
  return { totals, gaps };
}

/** Analyze one session's parsed JSON entries. Pure; no I/O, no transcript text returned. */
export function analyzeSessionEntries(entries, options = {}) {
  const limits = { ...TOKEN_COST_LIMITS, ...options };
  const file = options.file ?? "(session)";
  const date = options.date ?? "(unknown)";

  const totals = {
    turns: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    totalTokens: 0,
    invalidationExcess: 0,
    invalidationTurns: 0,
    invalidationMidTurn: 0,
    invalidationBoundary: 0,
    noCacheTurns: 0,
    noCacheInput: 0,
    normalInput: 0,
    toolActivations: 0,
    compactions: 0,
    resumeGaps: 0,
    providerExpiryLikely: 0,
    harnessMutationGaps: 0,
    unexplainedMissGaps: 0,
    postCompactionGaps: 0,
  };
  const byModel = new Map();
  const byDay = new Map();
  const injections = new Map(); // segmentId -> hook -> last cumulative
  const topTurns = [];
  const resume = analyzeResumeGaps(entries, limits);
  Object.assign(totals, resume.totals);

  let pendingChars = 0;
  let prevOutput = 0;
  let atBoundary = true;

  const dayOf = (entry) =>
    typeof entry?.timestamp === "string" ? entry.timestamp.slice(0, 10) : date;

  const bucket = (map, key, seed) => {
    let row = map.get(key);
    if (!row) {
      row = seed();
      map.set(key, row);
    }
    return row;
  };

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;

    if (entry.type === "compaction") {
      totals.compactions++;
      pendingChars = 0;
      atBoundary = true;
      continue;
    }

    if (entry.type === "custom" && entry.customType === "session-metrics-v1") {
      const data = entry.data;
      if (data && data.hooks && typeof data.hooks === "object") {
        const sid = typeof data.segment === "string" ? data.segment : "default";
        const seg = bucket(injections, sid, () => new Map());
        for (const [hook, value] of Object.entries(data.hooks)) {
          if (!value || typeof value !== "object") continue;
          const prev = seg.get(hook) ?? {
            addedChars: 0,
            removedChars: 0,
            calls: 0,
          };
          // Cumulative within a segment: keep the maximum, never sum repeats.
          seg.set(hook, {
            addedChars: Math.max(prev.addedChars, num(value.addedChars)),
            removedChars: Math.max(prev.removedChars, num(value.removedChars)),
            calls: Math.max(prev.calls, num(value.calls)),
          });
        }
      }
      continue;
    }

    if (
      entry.type === "custom" &&
      entry.customType === "harness-tool-activation-v1"
    ) {
      totals.toolActivations++;
      continue;
    }

    if (entry.type === "custom_message") {
      const size = typeof entry.content === "string" ? entry.content.length : 0;
      pendingChars += size;
      if (BOUNDARY_CUSTOM_TYPES.has(entry.customType)) atBoundary = true;
      continue;
    }

    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message || !LIVE_ROLES.has(message.role)) continue;

    if (message.role === "user") {
      pendingChars += messageChars(message);
      atBoundary = true;
      continue;
    }
    if (message.role === "toolResult") {
      pendingChars += messageChars(message);
      continue;
    }

    // assistant
    const usage = usageOf(message);
    if (!usage) {
      pendingChars = messageChars(message);
      continue;
    }
    const newContentTokens =
      Math.round(pendingChars / limits.charsPerToken) + prevOutput;
    const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
    const excess = usage.input - newContentTokens;
    const dateKey = dayOf(entry);
    const day = bucket(byDay, dateKey, () => ({
      date: dateKey,
      turns: 0,
      input: 0,
      cacheRead: 0,
      totalTokens: 0,
      invalidationExcess: 0,
      invalidTurns: 0,
      noCacheTurns: 0,
      noCacheInput: 0,
      normalInput: 0,
      toolActivations: 0,
    }));
    const route = routeOf(message);
    const model = bucket(byModel, route, () => ({
      route,
      turns: 0,
      input: 0,
      cacheRead: 0,
      invalidationExcess: 0,
      noCacheInput: 0,
      normalInput: 0,
    }));

    totals.turns++;
    totals.input += usage.input;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.output += usage.output;
    totals.totalTokens += usage.totalTokens;
    day.turns++;
    day.input += usage.input;
    day.cacheRead += usage.cacheRead;
    day.totalTokens += usage.totalTokens;
    model.turns++;
    model.input += usage.input;
    model.cacheRead += usage.cacheRead;

    if (promptTokens > limits.minPromptTokens) {
      if (usage.cacheRead === 0 && usage.cacheWrite === 0) {
        totals.noCacheTurns++;
        totals.noCacheInput += usage.input;
        day.noCacheTurns++;
        day.noCacheInput += usage.input;
        model.noCacheInput += usage.input;
      } else if (excess > limits.minExcessTokens) {
        totals.invalidationTurns++;
        totals.invalidationExcess += excess;
        day.invalidTurns++;
        day.invalidationExcess += excess;
        model.invalidationExcess += excess;
        if (atBoundary) totals.invalidationBoundary++;
        else totals.invalidationMidTurn++;
        topTurns.push({
          file,
          date: dateKey,
          turn: totals.turns,
          input: usage.input,
          cacheRead: usage.cacheRead,
          estimatedNewTokens: newContentTokens,
          excess,
          scope: atBoundary ? "user-boundary" : "mid-turn",
        });
      } else {
        totals.normalInput += usage.input;
        day.normalInput += usage.input;
        model.normalInput += usage.input;
      }
    } else {
      totals.normalInput += usage.input;
      day.normalInput += usage.input;
      model.normalInput += usage.input;
    }

    pendingChars = messageChars(message);
    prevOutput = usage.output + usage.reasoning;
    atBoundary = false;
  }

  // Collapse cumulative per-segment hook maps into one row per hook.
  const hookRows = new Map();
  for (const seg of injections.values()) {
    for (const [hook, value] of seg) {
      const row = hookRows.get(hook) ?? {
        hook,
        calls: 0,
        addedChars: 0,
        removedChars: 0,
      };
      row.calls += value.calls;
      row.addedChars += value.addedChars;
      row.removedChars += value.removedChars;
      hookRows.set(hook, row);
    }
  }

  return {
    file,
    date,
    totals,
    byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    byModel: [...byModel.values()].sort((a, b) => b.input - a.input),
    injections: [...hookRows.values()].sort(
      (a, b) => b.addedChars - a.addedChars,
    ),
    topTurns: topTurns.sort((a, b) => b.excess - a.excess),
    topResumeGaps: [...resume.gaps]
      .sort((a, b) => (b.inputAfter ?? 0) - (a.inputAfter ?? 0))
      .slice(0, limits.topCount),
  };
}

/** Aggregate per-session analyses into a day/model/turn report. */
export function aggregateSessions(sessions, options = {}) {
  const limits = { ...TOKEN_COST_LIMITS, ...options };
  const totals = {
    sessions: sessions.length,
    turns: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    totalTokens: 0,
    invalidationExcess: 0,
    invalidationTurns: 0,
    invalidationMidTurn: 0,
    invalidationBoundary: 0,
    noCacheTurns: 0,
    noCacheInput: 0,
    normalInput: 0,
    toolActivations: 0,
    compactions: 0,
    resumeGaps: 0,
    providerExpiryLikely: 0,
    harnessMutationGaps: 0,
    unexplainedMissGaps: 0,
    postCompactionGaps: 0,
  };
  const byDay = new Map();
  const byModel = new Map();
  const injections = new Map();
  const topTurns = [];
  const topResumeGaps = [];

  for (const session of sessions) {
    const t = session.totals;
    for (const key of Object.keys(totals)) {
      if (key === "sessions") continue;
      totals[key] += t[key] ?? 0;
    }
    for (const day of session.byDay) {
      const row = byDay.get(day.date) ?? {
        date: day.date,
        turns: 0,
        input: 0,
        cacheRead: 0,
        totalTokens: 0,
        invalidTurns: 0,
        invalidationExcess: 0,
        noCacheTurns: 0,
        noCacheInput: 0,
        normalInput: 0,
        toolActivations: 0,
      };
      for (const key of [
        "turns",
        "input",
        "cacheRead",
        "totalTokens",
        "invalidTurns",
        "invalidationExcess",
        "noCacheTurns",
        "noCacheInput",
        "normalInput",
      ])
        row[key] += day[key] ?? 0;
      byDay.set(day.date, row);
    }
    for (const model of session.byModel) {
      const row = byModel.get(model.route) ?? {
        route: model.route,
        turns: 0,
        input: 0,
        cacheRead: 0,
        invalidationExcess: 0,
        noCacheInput: 0,
        normalInput: 0,
      };
      for (const key of [
        "turns",
        "input",
        "cacheRead",
        "invalidationExcess",
        "noCacheInput",
        "normalInput",
      ])
        row[key] += model[key] ?? 0;
      byModel.set(model.route, row);
    }
    for (const hook of session.injections) {
      const row = injections.get(hook.hook) ?? {
        hook: hook.hook,
        calls: 0,
        addedChars: 0,
        removedChars: 0,
      };
      row.calls += hook.calls;
      row.addedChars += hook.addedChars;
      row.removedChars += hook.removedChars;
      injections.set(hook.hook, row);
    }
    topTurns.push(...session.topTurns);
    topResumeGaps.push(...(session.topResumeGaps ?? []));
  }

  const pct = (part, whole) => (whole > 0 ? (100 * part) / whole : 0);
  const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    thresholds: {
      minPromptTokens: limits.minPromptTokens,
      minExcessTokens: limits.minExcessTokens,
      charsPerToken: limits.charsPerToken,
      idleReferenceMs: limits.idleReferenceMs,
    },
    totals: {
      ...totals,
      cacheHitRate: pct(
        totals.cacheRead,
        totals.input + totals.cacheRead + totals.cacheWrite,
      ),
      invalidationShareOfInput: pct(totals.invalidationExcess, totals.input),
      reSentShareOfInput: pct(
        totals.invalidationExcess + totals.noCacheInput,
        totals.input,
      ),
    },
    byDay: days,
    byModel: [...byModel.values()].sort((a, b) => b.input - a.input),
    injections: [...injections.values()].sort(
      (a, b) => b.addedChars - a.addedChars,
    ),
    topTurns: topTurns
      .sort((a, b) => b.excess - a.excess)
      .slice(0, limits.topCount),
    topResumeGaps: topResumeGaps
      .sort((a, b) => (b.inputAfter ?? 0) - (a.inputAfter ?? 0))
      .slice(0, limits.topCount),
  };
  return result;
}

/** Parse one JSONL session file into entries, bounded. */
export function parseSessionLines(text, limits = TOKEN_COST_LIMITS) {
  const entries = [];
  let skipped = 0;
  const lines = String(text).split("\n");
  const cap = Math.min(lines.length, limits.maxEntriesPerFile);
  for (let i = 0; i < cap; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line[0] !== "{") {
      skipped++;
      continue;
    }
    try {
      entries.push(JSON.parse(line));
    } catch {
      skipped++;
    }
  }
  return { entries, skipped, truncated: lines.length > cap };
}

/** Scan a directory tree of .jsonl session files (bounded, read-only). */
export async function scanTokenCost(options) {
  const { readdir, readFile, stat } = await import("node:fs/promises");
  const path = await import("node:path");
  const limits = { ...TOKEN_COST_LIMITS, ...options };
  const root = path.resolve(options.sessionsDir);
  const since = typeof options.since === "string" ? options.since : undefined;
  const files = [];

  const walk = async (dir, depth) => {
    if (depth > 6 || files.length >= limits.maxFiles) return;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (files.length >= limits.maxFiles) return;
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) await walk(full, depth + 1);
      else if (dirent.isFile() && dirent.name.endsWith(".jsonl"))
        files.push(full);
    }
  };
  await walk(root, 0);

  const sessions = [];
  let filesScanned = 0;
  let filesSkipped = 0;
  const sorted = files.sort();
  for (const file of sorted) {
    try {
      const info = await stat(file);
      if (info.size > limits.maxFileBytes) {
        filesSkipped++;
        continue;
      }
      const base = path.basename(file);
      const date = base.slice(0, 10);
      if (since && /^\d{4}-\d{2}-\d{2}$/.test(date) && date < since) {
        filesSkipped++;
        continue;
      }
      const text = await readFile(file, "utf8");
      const { entries, skipped, truncated } = parseSessionLines(text, limits);
      if (skipped && entries.length === 0) {
        filesSkipped++;
        continue;
      }
      const analysis = analyzeSessionEntries(entries, {
        file: base,
        date,
        ...limits,
      });
      if (analysis.totals.turns === 0) {
        filesSkipped++;
        continue;
      }
      analysis.truncated = truncated;
      sessions.push(analysis);
      filesScanned++;
    } catch {
      filesSkipped++;
    }
  }

  const report = aggregateSessions(sessions, limits);
  report.filesScanned = filesScanned;
  report.filesSkipped = filesSkipped;
  report.sessionsDir = root;
  report.since = since ?? null;
  return report;
}

const integer = (value) => Number(value).toLocaleString("en-US");

/** Human-readable summary. No transcript text is included. */
export function formatReport(report) {
  const lines = [];
  const t = report.totals;
  lines.push(
    `Token/cache diagnostics · ${report.filesScanned} sessions scanned${report.since ? ` since ${report.since}` : ""}`,
  );
  lines.push(
    `Totals: ${integer(t.turns)} turns · ${integer(t.totalTokens)} total tokens · ${t.cacheHitRate.toFixed(1)}% cache hit`,
  );
  lines.push(
    `Uncached input ${integer(t.input)} tokens = invalidation ${integer(t.invalidationExcess)} (${t.invalidationShareOfInput.toFixed(0)}%) + provider no-cache ${integer(t.noCacheInput)} + genuinely new ${integer(t.normalInput)}`,
  );
  lines.push(
    `Invalidating turns: ${integer(t.invalidationTurns)} (mid-turn ${integer(t.invalidationMidTurn)}, user-boundary ${integer(t.invalidationBoundary)}); tool activations ${integer(t.toolActivations)}; compactions ${integer(t.compactions)}`,
  );
  lines.push("");
  lines.push("By day:");
  for (const day of report.byDay.slice(-14)) {
    const hit =
      day.input + day.cacheRead > 0
        ? (100 * day.cacheRead) / (day.input + day.cacheRead)
        : 0;
    lines.push(
      `  ${day.date}  turns=${integer(day.turns)}  total=${integer(day.totalTokens)}  hit=${hit.toFixed(0)}%  invalidation=${integer(day.invalidationExcess)} (${integer(day.invalidTurns)} turns)  noCache=${integer(day.noCacheInput)}`,
    );
  }
  if (report.byModel.length) {
    lines.push("");
    lines.push("By route (top input):");
    for (const model of report.byModel.slice(0, 10)) {
      lines.push(
        `  ${model.route}  turns=${integer(model.turns)}  input=${integer(model.input)}  invalidation=${integer(model.invalidationExcess)}  noCache=${integer(model.noCacheInput)}`,
      );
    }
  }
  if (report.injections.length) {
    lines.push("");
    lines.push("Hook payload additions (segment-deduplicated):");
    for (const hook of report.injections
      .filter((h) => h.addedChars > 0)
      .slice(0, 8)) {
      lines.push(
        `  ${hook.hook}  calls=${integer(hook.calls)}  added=${integer(hook.addedChars)} chars (~${integer(Math.round(hook.addedChars / 4))} tok)  removed=${integer(hook.removedChars)}`,
      );
    }
  }
  if (report.topTurns.length) {
    lines.push("");
    lines.push("Largest single-turn invalidations:");
    for (const turn of report.topTurns.slice(0, 8)) {
      lines.push(
        `  excess=${integer(turn.excess)}  input=${integer(turn.input)}  ~new=${integer(turn.estimatedNewTokens)}  ${turn.scope}  ${turn.date}  ${turn.file}`,
      );
    }
  }
  if (report.topResumeGaps?.length) {
    lines.push("");
    lines.push(
      `Resume gaps across consecutive requests (idle reference ${(report.thresholds?.idleReferenceMs ?? 300000) / 60000}min; same prefix + miss = provider-side, changed prefix = harness-side):`,
    );
    for (const gap of report.topResumeGaps.slice(0, 8)) {
      const age =
        gap.gapMs === null || gap.gapMs === undefined
          ? "age?"
          : gap.gapMs < 60000
            ? `${Math.round(gap.gapMs / 1000)}s`
            : `${(gap.gapMs / 60000).toFixed(1)}min`;
      lines.push(
        `  ${gap.classification}  input=${integer(gap.inputAfter)}  age=${age}  prefixSame=${gap.prefixSame}  cache=${integer(gap.cacheBefore)}->${integer(gap.cacheAfter)}  boundary=[${(gap.boundary ?? []).join(",")}]  ${gap.route ?? ""}`,
      );
    }
  }
  return lines.join("\n");
}
