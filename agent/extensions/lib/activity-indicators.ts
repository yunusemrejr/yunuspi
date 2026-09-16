/** Harness activity indicators: tiny TUI lines for harness-internal work.
 *
 * Tools already render as native single lines in the transcript; this module
 * covers what the transcript otherwise hides: skill routing/reads, local
 * ML-ish helpers (intent, mini/smol selection), the preferred/free model
 * mixer (picks as lines; per-route skip reasons in ring/metrics/report),
 * local-provider refreshes and reminder compliance. Every tapped health
 * event lands in the bounded ring and the counters; only notable kinds
 * become transcript lines, deduplicated and budgeted so indicators stay
 * tiny and never disturb the turn.
 *
 * Context cost is deliberate: `content` stays under ~64 chars (details carry
 * display data and never enter LLM context). Sends always use
 * `{ triggerTurn: false }` so a line defers to end-of-turn while streaming.
 * Pure module: no pi imports, safe for offline tests. The renderer lives
 * next to the other custom renderers in pi-subagents extension/index.ts.
 */
export const ACTIVITY_MESSAGE_TYPE = "harness-activity";
export const ACTIVITY_VIEW = Symbol.for("yunus-pi.activity-view.v1");

export type ActivityStatus = "ok" | "skip" | "error";
export interface ActivityRecord {
  t: number;
  kind: string;
  label: string;
  status: ActivityStatus;
  ms?: number;
  detail?: string;
}
export interface ActivityLocalState {
  outcome: string;
  count: number;
  at: number;
}
export interface ActivityCounters {
  events: Record<string, number>;
  /** Per-kind decision/outcome value splits (bounded: 64 kinds × 16 values). */
  decisions: Record<string, Record<string, number>>;
  lines: number;
  dropped: number;
  errors: ActivityRecord[];
  skips: Record<string, number>;
  local: Record<string, ActivityLocalState>;
}

/** Default-deny: only these health kinds may become transcript lines.
 * `error` = line only on error status (routine ok stays in ring/metrics). */
const LINE_POLICY: Record<string, "all" | "error"> = {
  "skill.route": "all",
  "skill.read": "all",
  "skill.resolve": "all",
  "skill.rank": "all",
  "guidance.delivered": "all",
  "ml.intent": "all",
  "ml.mini.select": "all",
  "ml.smol.take": "all",
  "ml.smol.offer": "error",
  "model.mix": "all",
  // Routine preference-chain skips (excluded/cooling/unresolved) fire per
  // dispatch and would spam a line per skipped route; they stay in the
  // ring, counters, /metrics and the session report. Only an unexpected
  // skip outcome earns a transcript line.
  "model.skip": "error",
  "local.refresh": "all",
  "reminder.ack": "error",
  "reminder.follow": "error",
  "review.disposition": "all",
  "interp.sidecar": "all",
};

const DEDUPE_MS: Record<ActivityStatus, number> = { ok: 45_000, skip: 30_000, error: 10_000 };
/** Infrastructure states flap slowly; a 10s window would re-log every check. */
const DEDUPE_OVERRIDE: Array<[string, number]> = [
  ["local.refresh", 600_000],
  ["ml.smol.offer", 600_000],
  ["reminder.", 300_000],
];
const LINE_BUDGET_PER_MIN = 24;
const RING_MAX = 200;
const ERRORS_MAX = 8;

const clean = (value: unknown, max = 80): string =>
  String(value ?? "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/** Skill name from a read-tool path (parent dir of SKILL.md). Undefined when
 * the path is not a skill file, so callers can keep their hash fallback. */
export function skillNameFromPath(filePath: unknown): string | undefined {
  if (typeof filePath !== "string") return undefined;
  const match = /([^/\\]+)[/\\]SKILL\.md$/.exec(filePath);
  const name = match?.[1]?.trim();
  if (!name || name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) return undefined;
  return name;
}

const ROUTINE_SKIP = new Set([
  "raw", "ineligible", "busy", "cooldown", "hash-mismatch", "no-runtime",
  "unresolved", "excluded", "cooling",
]);

export interface DescribedActivity {
  label: string;
  status: ActivityStatus;
  ms?: number;
  detail?: string;
}

/** Cheap display projection of a raw health event. Never throws. */
export function describeActivity(kind: string, data: Record<string, unknown>): DescribedActivity {
  try {
    const ms = typeof data.durationMs === "number" && Number.isFinite(data.durationMs) && data.durationMs >= 0
      ? Math.round(data.durationMs) : undefined;
    const isError = data.isError === true;
    const decision = typeof data.decision === "string" ? data.decision : "";
    const outcome = typeof data.outcome === "string" ? data.outcome : "";
    const route = typeof data.route === "string" ? data.route : "";
    const skill = typeof data.skill === "string" ? data.skill : "";
    if (kind === "skill.read") {
      const name = skillNameFromPath(skill) ?? skill;
      return { label: clean(name || "skill", 60), status: isError ? "error" : "ok", ms, detail: data.partial === true ? "partial" : "full" };
    }
    if (kind === "skill.route" || kind === "ml.intent") {
      const sim = typeof data.similarity === "number" && Number.isFinite(data.similarity)
        ? `sim ${data.similarity.toFixed(2)}` : undefined;
      return { label: clean(route || "?", 60), status: "ok", detail: sim };
    }
    if (kind === "skill.resolve") {
      return { label: clean(skill || "?", 60), status: decision === "missing" || isError ? "error" : "ok", detail: clean(decision || "", 24) || undefined };
    }
    if (kind === "skill.rank") {
      const score = typeof data.score === "number" && Number.isFinite(data.score) ? `score ${data.score.toFixed(2)}` : undefined;
      return { label: clean(skill || "?", 60), status: "ok", detail: score };
    }
    if (kind === "guidance.delivered") {
      return { label: clean(decision || "hint", 60), status: "ok" };
    }
    if (kind === "ml.mini.select" || kind === "ml.smol.take") {
      const ok = decision === "selected" || decision === "cache-hit";
      return { label: clean(decision || "?", 32), status: isError ? "error" : ok ? "ok" : "skip", ms };
    }
    if (kind === "ml.smol.offer") {
      const ok = decision === "selected" || decision === "cache-hit";
      return { label: clean(decision || "?", 32), status: isError || decision === "no-runtime" ? "error" : ok ? "ok" : "skip", ms };
    }
    if (kind === "model.mix") {
      return { label: clean(route || "?", 80), status: "ok", detail: clean(decision || "", 24) || undefined };
    }
    if (kind === "model.skip") {
      const reason = clean(outcome || decision || "skipped", 24);
      return { label: clean(route || "?", 80), status: ROUTINE_SKIP.has(reason) ? "skip" : "error", detail: reason };
    }
    if (kind === "local.refresh") {
      const count = typeof data.count === "number" && Number.isFinite(data.count) ? ` ${Math.round(data.count)} models` : "";
      return { label: clean(route || "local", 40), status: isError || outcome === "unavailable" ? "error" : "ok", detail: clean(`${outcome}${count}`, 40) || undefined };
    }
    if (kind === "reminder.ack") {
      const ignored = decision === "ignored";
      return { label: "manual reminder", status: ignored || isError ? "error" : "ok", detail: clean(decision || "", 24) || undefined };
    }
    if (kind === "reminder.follow") {
      return { label: clean(decision || "follow-through", 32), status: "ok" };
    }
    if (kind === "interp.sidecar") {
      const read = clean(decision || "sidecar", 24);
      return {
        label: read === "additive" || read === "redirect" ? `second-read ${read}` : "second-read",
        status: read === "additive" || read === "redirect" ? "ok" : "skip",
        detail: read === "additive" || read === "redirect" ? undefined : read || undefined,
      };
    }
    if (kind === "review.disposition") {
      const blockers = typeof data.count === "number" && Number.isFinite(data.count) ? Math.max(0, Math.round(data.count)) : 0;
      return {
        label: clean(decision || "review", 24),
        status: decision === "accepted" ? "ok" : "error",
        detail: blockers ? `${blockers} blocking` : undefined,
      };
    }
    return { label: clean(route || skill || decision || outcome || kind, 60), status: isError ? "error" : "ok", ms };
  } catch {
    return { label: "?", status: "error" };
  }
}

export type ActivitySender = (
  message: { customType: string; content: string; display: boolean; details: Record<string, unknown> },
  options: { triggerTurn: boolean },
) => unknown;

export interface ActivityIndicators {
  note: (kind: string, data?: Record<string, unknown>) => void;
  reset: () => void;
  dispose: () => void;
  snapshot: () => ActivityRecord[];
  counters: () => ActivityCounters;
}

export function createActivityIndicators(send: ActivitySender): ActivityIndicators {
  const ring: ActivityRecord[] = [];
  const events: Record<string, number> = {};
  const decisions: Record<string, Record<string, number>> = {};
  const skips: Record<string, number> = {};
  const local: Record<string, ActivityLocalState> = {};
  const errors: ActivityRecord[] = [];
  const lastLine = new Map<string, number>();
  const lineAt: number[] = [];
  let lines = 0;
  let dropped = 0;

  const dedupeMs = (kind: string, status: ActivityStatus): number => {
    for (const [prefix, ms] of DEDUPE_OVERRIDE) if (kind.startsWith(prefix)) return ms;
    return DEDUPE_MS[status];
  };

  const counters = (): ActivityCounters => ({
    events: { ...events },
    decisions: Object.fromEntries(Object.entries(decisions).map(([k, v]) => [k, { ...v }])),
    lines,
    dropped,
    errors: errors.slice(-ERRORS_MAX),
    skips: { ...skips },
    local: Object.fromEntries(Object.entries(local).map(([k, v]) => [k, { ...v }])),
  });
  (globalThis as Record<symbol, unknown>)[ACTIVITY_VIEW] = counters;

  const note = (kind: string, data: Record<string, unknown> = {}): void => {
    if (typeof kind !== "string" || !kind || process.env.PI_ACTIVITY_INDICATORS === "off") return;
    const now = Date.now();
    try {
      events[kind] = (events[kind] ?? 0) + 1;
      const vote = typeof data.decision === "string" && data.decision
        ? data.decision
        : typeof data.outcome === "string" && data.outcome ? data.outcome : "";
      if (vote) {
        const key = clean(vote, 24);
        if (key) {
          const row = decisions[kind] ?? (Object.keys(decisions).length < 64 ? (decisions[kind] = {}) : undefined);
          if (row && (row[key] !== undefined || Object.keys(row).length < 16)) row[key] = (row[key] ?? 0) + 1;
        }
      }
      const d = describeActivity(kind, data);
      const rec: ActivityRecord = {
        t: now, kind: kind.slice(0, 64), label: d.label, status: d.status,
        ...(d.ms !== undefined ? { ms: d.ms } : {}),
        ...(d.detail ? { detail: d.detail } : {}),
      };
      ring.push(rec);
      if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
      if (d.status === "error") {
        errors.push(rec);
        if (errors.length > ERRORS_MAX) errors.splice(0, errors.length - ERRORS_MAX);
      }
      if (kind === "model.skip" && d.detail) skips[d.detail] = (skips[d.detail] ?? 0) + 1;
      if (kind === "local.refresh") {
        const key = d.label || "local";
        local[key] = { outcome: d.detail ?? "ok", count: (local[key]?.count ?? 0) + 1, at: now };
      }
      const policy = LINE_POLICY[kind];
      if (!policy) return;
      if (policy === "error" && d.status !== "error") return;
      // Child sessions have no TUI: lines would only bloat child context.
      if (process.env.PI_SUBAGENT_CHILD) return;
      const key = `${kind}\0${d.label}\0${d.status}`;
      const last = lastLine.get(key) ?? 0;
      if (now - last < dedupeMs(kind, d.status)) return;
      while (lineAt.length && now - lineAt[0]! > 60_000) lineAt.shift();
      if (lineAt.length >= LINE_BUDGET_PER_MIN) {
        dropped++;
        return;
      }
      lastLine.set(key, now);
      if (lastLine.size > 512) {
        const oldest = [...lastLine.entries()].sort((a, b) => a[1] - b[1]).slice(0, lastLine.size - 512);
        for (const [k] of oldest) lastLine.delete(k);
      }
      lineAt.push(now);
      lines++;
      const content = clean(`activity ${kind} ${d.label} ${d.status}`, 64);
      try {
        const result = send(
          {
            customType: ACTIVITY_MESSAGE_TYPE,
            content,
            display: true,
            details: {
              kind: rec.kind, label: rec.label, status: rec.status,
              ...(rec.ms !== undefined ? { ms: rec.ms } : {}),
              ...(rec.detail ? { detail: rec.detail } : {}),
            },
          },
          { triggerTurn: false },
        );
        if (result && typeof (result as PromiseLike<unknown>).then === "function") {
          (result as PromiseLike<unknown>).then(undefined, () => { dropped++; });
        }
      } catch {
        dropped++;
      }
    } catch {
      dropped++;
    }
  };

  const reset = (): void => {
    ring.length = 0;
    errors.length = 0;
    lastLine.clear();
    lineAt.length = 0;
    for (const k of Object.keys(events)) delete events[k];
    for (const k of Object.keys(decisions)) delete decisions[k];
    for (const k of Object.keys(skips)) delete skips[k];
    for (const k of Object.keys(local)) delete local[k];
    lines = 0;
    dropped = 0;
  };

  return {
    note,
    reset,
    dispose: () => {
      if ((globalThis as Record<symbol, unknown>)[ACTIVITY_VIEW] === counters) {
        delete (globalThis as Record<symbol, unknown>)[ACTIVITY_VIEW];
      }
    },
    snapshot: () => ring.slice(),
    counters,
  };
}

/** Transcript-line payload. `content` stays tiny for context; the renderer
 * paints from these details, which never enter LLM context. */
export interface ActivityDetails {
  kind: string;
  label: string;
  status: ActivityStatus;
  ms?: number;
  detail?: string;
}

/** Short TUI tag per health kind; unknown kinds render in full. */
export const ACTIVITY_TAGS: Record<string, string> = {
  "skill.route": "skill",
  "skill.read": "skill",
  "skill.resolve": "skill",
  "skill.rank": "skill",
  "guidance.delivered": "hint",
  "ml.intent": "intent",
  "ml.mini.select": "mini",
  "ml.smol.take": "smol",
  "ml.smol.offer": "smol",
  "model.mix": "model",
  "model.skip": "model",
  "local.refresh": "local",
  "reminder.ack": "reminder",
  "reminder.follow": "reminder",
  "review.disposition": "review",
  "interp.sidecar": "interp",
};

/** In-process counters view for /metrics and /export-json. Undefined when the
 * health-log extension (the tap owner) has not started in this process. */
export function activityView(): ActivityCounters | undefined {
  try {
    const view = (globalThis as Record<symbol, unknown>)[ACTIVITY_VIEW];
    return typeof view === "function" ? (view as () => ActivityCounters)() : undefined;
  } catch {
    return undefined;
  }
}
