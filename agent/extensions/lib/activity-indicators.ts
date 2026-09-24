import { sessionObservability } from './session-observability.ts';
/** Harness activity indicators: tiny TUI lines for harness-internal work.
 *
 * Tools already render as native single lines in the transcript; this module
 * covers what the transcript otherwise hides: skill routing/reads, local
 * ML-ish helpers (intent, mini/smol selection), model preference skips
 * (with historical mixed-route events retained for older session reports),
 * local-provider refreshes and reminder compliance. Every tapped health
 * event lands in the bounded ring and the counters; only notable kinds
 * become transcript lines, deduplicated and budgeted so indicators stay
 * tiny and never disturb the turn.
 *
 * These lines are display-only: `details` carry renderer data and
 * `excludeFromContext` keeps the compact label out of LLM context. Sends
 * always use `{ triggerTurn: false }`; display-only lines can flow while a
 * tool is running without becoming provider input.
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
  // Guardian heartbeats are routine (measured 245 identical lines a day);
  // they feed the live pulse. Verdicts and interventions are lines.
  "guardian.observing": "error",
  "guardian.evaluated": "error",
  "guardian.decision": "all",
  "hook.fired": "all",
  // A router match is not a read or a use; matches feed the pulse.
  "skill.route": "error",
  "skill.read": "all",
  "skill.resolve": "all",
  "skill.discovery": "error",
  "guidance.delivered": "all",
  // Local-model verdicts on skill hints: what was filtered and why.
  "skill.gate": "all",
  "model.mix": "all",
  // Routine preference-chain skips (excluded/cooling/unresolved) fire per
  // dispatch and would spam a line per skipped route; they stay in the
  // ring, counters, /metrics and the session report. Only an unexpected
  // skip outcome earns a transcript line.
  "model.skip": "error",
  // A local server that is not running is normal; only failures show.
  "local.refresh": "error",
  "reminder.ack": "error",
  "reminder.follow": "error",
  "review.disposition": "all",
};
/** Local helpers whose routine completions update the live pulse instead of
 * the transcript: they run on most tool results and change ordering only. */
const PULSE_ONLY_INTELLIGENCE = new Set(["ml.fuzzy.used", "ml.radar.rank", "ml.retrieval.used"]);

const DEDUPE_MS: Record<ActivityStatus, number> = { ok: 45_000, skip: 30_000, error: 10_000 };
/** Infrastructure states flap slowly; a 10s window would re-log every check.
 * Guardian lines are keyed by WASM state, so a state change still shows at
 * once; an unchanged heartbeat (measured 71 lines in one session) does not.
 * File-based routing re-matches the same skill on every edit of that file
 * type (27 identical lines measured); a repeat match is not news. */
const DEDUPE_OVERRIDE: Array<[string, number]> = [
  ["guardian.", 300_000],
  ["skill.route", 600_000],
  ["local.refresh", 600_000],
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

/** Legacy component classification for successful internal results. This is
 * not a provider-delivery receipt: the stage-aware projection below separates
 * inference completion from context delivery. Labels never carry source text. */
export function intelligenceUseForEvent(kind: string, data: Record<string, unknown>): string | undefined {
  if (data.isError === true || data.disabled === true || data.shadow === true) return undefined;
  switch (kind) {
    case "ml.jev.used": return "JEV";
    case "ml.needle.call": return data.count === undefined || (typeof data.count === "number" && data.count > 0) ? "Needle3" : undefined;
    case "ml.smol.used": return "Local LM";
    case "ml.mini.used": return "Kompress";
    case "ml.intent": return "Intent classifier";
    case "ml.fuzzy.used": return "Fuzzy matching";
    case "ml.retrieval.used": return "Retrieval intelligence";
    case "ml.radar.rank": return data.decision === "on" && typeof data.count === "number" && data.count > 0 ? "Neural ranker" : undefined;
    default: return undefined;
  }
}

/** Fixed labels and bounded numeric evidence only: no prompt, selected text,
 * model output, file path or arbitrary payload enters the transcript. A
 * completed call is not proof that its result reached the main model. */
export function describeIntelligenceActivity(kind: string, data: Record<string, unknown>): DescribedActivity | undefined {
  const ms = typeof data.durationMs === "number" && Number.isFinite(data.durationMs) && data.durationMs >= 0 ? Math.round(data.durationMs) : undefined;
  const helpers: Record<string, string> = { needle: "Needle3", smol: "Local LM", kompress: "Kompress", jev: "JEV", deterministic: "Deterministic selection" };
  const amount = (key: string) => Number.isSafeInteger(data[key]) && Number(data[key]) >= 0 ? Number(data[key]) : undefined;
  const decision = typeof data.decision === "string" ? data.decision : "";
  const reason = typeof data.reason === "string" && /^[a-z-]{1,48}$/.test(data.reason) ? data.reason.replaceAll("-", " ") : undefined;
  const status: ActivityStatus = data.isError === true ? "error" : "ok";
  if (data.disabled === true || data.shadow === true || data.isError === true) return;
  if (kind === "ml.jev.skipped" || kind === "ml.needle.skipped") {
    const failed = ["unavailable", "unhealthy", "timeout", "no-key", "invalid-input"].includes(String(data.reason));
    return { label: kind === "ml.jev.skipped" ? "JEV" : "Needle3", status: failed ? "error" : "skip", ms,
      detail: `${failed ? "unavailable; fallback retained" : "skipped"}${reason ? ` · ${reason}` : ""}` };
  }
  if ((kind === "ml.evidence.delivered" || kind === "ml.evidence.returned") && typeof data.helper === "string" && Object.hasOwn(helpers, data.helper)) {
    const saved = amount("savedChars");
    return { label: helpers[data.helper], status, detail: `${kind === "ml.evidence.returned" ? "returned exact excerpts" : "added to model context"}${saved === undefined ? "" : ` · ${saved} characters ${kind === "ml.evidence.returned" ? "omitted" : "saved"}`}${data.cached === true ? " · cached selection" : ""}` };
  }
  if (kind === "ml.needle.call" && data.count !== 0) {
    const op = typeof data.op === "string" && ["embed", "rank", "classify", "extract"].includes(data.op) ? data.op : "result";
    const outcome = data.accepted === false
      ? { classify: "request type unclear · no label applied", rank: "no confident ranking · lexical order kept", embed: "embeddings unused", extract: "no excerpt confident enough", result: "low confidence · result unused" }[op]
      : { classify: "request type classified", rank: "candidates ranked", embed: "embeddings ready", extract: "excerpts selected", result: "result ready" }[op];
    return { label: "Needle3", status: data.accepted === false ? "skip" : status, ms,
      detail: `${data.coalesced === true ? "shared in-flight result" : data.cached === true ? "cached embeddings" : "local WASM"} · ${outcome}` };
  }
  if (kind === "ml.jev.used") {
    const questions = amount("questions");
    return { label: "JEV", status, ms, detail: `${data.cached === true ? "cached answer reused" : "remote judge answered"}${questions === undefined ? "" : ` · ${questions} ${questions === 1 ? "question" : "questions"}`}` };
  }
  if (kind === "ml.smol.inference" || kind === "ml.mini.select") return {
    label: kind === "ml.smol.inference" ? "Local LM" : "Kompress", status: decision === "selected" || decision === "cache-hit" ? status
      : kind === "ml.smol.inference" && reason && !["unknown", "model unknown", "insufficient savings", "cancelled"].includes(reason) ? "error" : "skip", ms,
    detail: `${data.cached === true || decision === "cache-hit" ? "cached selection" : decision === "selected" ? "local selection ready" : "local selection unused"}${reason ? ` · ${reason}` : ""}`,
  };
  if (kind === "ml.smol.offer" && decision !== "accepted") return { label: "Local LM", status: decision === "cache-hit" ? "ok" : decision === "no-runtime" ? "error" : "skip", detail: decision === "cache-hit" ? "cached selection ready" : `skipped${reason ? ` · ${reason}` : ""}` };
  if (kind === "ml.wasm.completed" && data.runtime === "tree-sitter-wasm" && data.helper === "source-check") return {
    label: "WASM source check", status, ms, detail: `${data.cached === true ? "cached" : "local parse complete"}${amount("findings") === undefined ? "" : ` · ${amount("findings")} findings`}`,
  };
  if (kind === "ml.smol.used" || kind === "ml.mini.used") return { label: kind === "ml.smol.used" ? "Local LM" : "Kompress", status, detail: "selection applied" };
  if (kind === "ml.fuzzy.used") return { label: "Fuzzy matching", status, detail: `local match applied${amount("count") === undefined ? "" : ` · ${amount("count")} matches`}` };
  if (kind === "ml.retrieval.used") return { label: "Retrieval intelligence", status, detail: { needle: "Needle3 ranking applied", fused: "Needle3 + lexical fused ranking applied", jev: "JEV ranking applied" }[decision] ?? "ranking applied" };
  if (kind === "ml.radar.rank" && decision === "on" && (amount("count") ?? 0) > 0) return { label: "Neural ranker", status, detail: `ranking applied · ${amount("count")} results` };
  if (kind === "ml.intent") return { label: "Intent classifier", status, detail: "local route selected" };
}

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
    if (kind === "guardian.observing" || kind === "guardian.evaluated") {
      const count = Number.isSafeInteger(data.count) && Number(data.count) >= 0 ? Number(data.count) : 0;
      const evaluations = Number.isSafeInteger(data.evaluations) && Number(data.evaluations) >= 0 ? Number(data.evaluations) : 0;
      const wasm = decision === "lazy" ? "failure detector on standby" : decision === "quarantined" ? "WASM unavailable"
        : decision === "initializing" ? "WASM initializing" : `${evaluations} WASM evaluations`;
      return { label: kind === "guardian.evaluated" ? "evaluated" : "observing", status: decision === "quarantined" ? "error" : "ok", detail: `${count} tool results · ${wasm}${data.promptCoverage === "bounded-out" ? " · prompt too large for constraint checks" : ""}` };
    }
    if (kind === "guardian.decision") {
      const check = clean(String(data.check ?? "check").replaceAll("-", " "), 40);
      const score = typeof data.score === "number" && Number.isFinite(data.score) && typeof data.threshold === "number" ? `WASM score ${data.score.toFixed(2)} ${data.score >= data.threshold ? "≥" : "<"} ${data.threshold.toFixed(2)}` : undefined;
      const verdict = decision === "intervened" ? "guidance sent to agent" : decision === "deferred" ? "deferred (one per window)" : "no intervention";
      return { label: check, status: decision === "intervened" ? "ok" : "skip", detail: [score, verdict].filter(Boolean).join(" · ") };
    }
    if (kind === "skill.gate") {
      const score = typeof data.score === "number" && Number.isFinite(data.score) ? ` · P(relevant) ${data.score.toFixed(2)}` : "";
      const verdict = decision === "kept" ? "hint kept" : decision === "filtered" ? "off-topic hint filtered" : "generic match ignored";
      return { label: clean(skill || "skill", 60), status: decision === "kept" ? "ok" : "skip", detail: `Local LM ${verdict}${score}` };
    }
    if (kind === "hook.fired") {
      return { label: clean(String(data.hook ?? "hook").replaceAll("-", " "), 48), status: "ok", detail: clean(`${data.tool ? `on ${data.tool} · ` : ""}${data.decision === "recovery" ? "recovery guidance" : "workflow guidance"} added to the result`, 80) };
    }
    if (kind === "skill.read") {
      const name = skillNameFromPath(skill) ?? skill;
      return { label: clean(name || "skill", 60), status: isError ? "error" : "ok", ms, detail: data.partial === true ? "partial" : "full" };
    }
    if (kind === "skill.route" || kind === "ml.intent") {
      const sim = typeof data.similarity === "number" && Number.isFinite(data.similarity)
        ? `sim ${data.similarity.toFixed(2)}` : undefined;
      // A router match is a suggestion, not a read or use of the skill.
      return { label: clean(route || "?", 60), status: "ok", detail: kind === "skill.route" ? ["router match, not a read", sim].filter(Boolean).join(" · ") : sim };
    }
    if (kind === "skill.resolve") {
      return { label: clean(skill || "?", 60), status: decision === "missing" || isError ? "error" : "ok", detail: clean(decision || "", 24) || undefined };
    }
    if (kind === "skill.rank") {
      const score = typeof data.score === "number" && Number.isFinite(data.score) ? `score ${data.score.toFixed(2)}` : undefined;
      return { label: clean(skill || "?", 60), status: "ok", detail: score };
    }
    if (kind === "skill.discovery") {
      const failure = typeof data.error === "string" ? data.error : "";
      return {
        label: "skill discovery",
        status: decision === "failed" || isError ? "error" : decision === "completed" ? "ok" : "skip",
        detail: clean(failure || route || decision || "", 60) || undefined,
      };
    }
    if (kind === "guidance.delivered") {
      const label = decision === "skill-or-tool" ? "skill/tool suggestion sent to agent"
        : decision.startsWith("signal:") ? `${decision.slice(7).replaceAll("-", " ")} guidance sent to agent` : decision || "hint";
      return { label: clean(label, 60), status: "ok" };
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
      if (reason === "length-stop") return { label: clean(route || "?", 80), status: "skip", detail: "output limit reached" };
      return { label: clean(route || "?", 80), status: ROUTINE_SKIP.has(reason) ? "skip" : "error", detail: reason };
    }
    if (kind === "local.refresh") {
      const count = typeof data.count === "number" && Number.isFinite(data.count) ? ` ${Math.round(data.count)} models` : "";
      return { label: clean(route || "local", 40), status: isError || outcome === "unavailable" ? "error" : outcome === "not-running" ? "skip" : "ok", detail: clean(`${outcome.replace("-", " ")}${count}`, 40) || undefined };
    }
    if (kind === "reminder.ack") {
      const ignored = decision === "ignored";
      return { label: "manual reminder", status: ignored || isError ? "error" : "ok", detail: clean(decision || "", 24) || undefined };
    }
    if (kind === "reminder.follow") {
      return { label: clean(decision || "follow-through", 32), status: "ok" };
    }
    if (kind === "review.disposition") {
      const blockers = typeof data.count === "number" && Number.isFinite(data.count) ? Math.max(0, Math.round(data.count)) : 0;
      return {
        label: clean(decision || "review", 24),
        status: decision === "accepted" ? "ok" : decision === "blocked" ? "skip" : "error",
        detail: blockers ? `${blockers} blocking` : undefined,
      };
    }
    return { label: clean(route || skill || decision || outcome || kind, 60), status: isError ? "error" : "ok", ms };
  } catch {
    return { label: "?", status: "error" };
  }
}

export type ActivitySender = (
  message: { customType: string; content: string; display: boolean; details: Record<string, unknown>; excludeFromContext: true },
  options: { triggerTurn: boolean },
) => unknown;

export interface ActivityIndicators {
  note: (kind: string, data?: Record<string, unknown>) => void;
  reset: () => void;
  dispose: () => void;
  snapshot: () => ActivityRecord[];
  counters: () => ActivityCounters;
}

/** Live one-line summary of background harness work for the footer. */
export interface ActivityPulse { set(text: string | undefined): void; available(): boolean }
interface PulseCounts { guardianChecks: number; guardianWasm: number; guardianVerdicts: number; guardianInterventions: number; needle: number; jev: number; fuzzy: number; ranker: number; local: number; hooks: number; hints: number; skills: number }
const emptyPulse = (): PulseCounts => ({ guardianChecks: 0, guardianWasm: 0, guardianVerdicts: 0, guardianInterventions: 0, needle: 0, jev: 0, fuzzy: 0, ranker: 0, local: 0, hooks: 0, hints: 0, skills: 0 });
export function renderActivityPulse(counts: PulseCounts): string | undefined {
  const parts: string[] = [];
  if (counts.guardianChecks || counts.guardianVerdicts) parts.push(`Guardian ${counts.guardianChecks} checks${counts.guardianWasm ? ` · ${counts.guardianWasm} WASM` : ""}${counts.guardianInterventions ? ` · ${counts.guardianInterventions} sent` : ""}`);
  const named: Array<[number, string]> = [[counts.needle, "Needle3"], [counts.jev, "JEV"], [counts.local, "local LM"], [counts.fuzzy, "fuzzy"], [counts.ranker, "ranker"], [counts.hooks, "hooks"], [counts.hints, "hints"], [counts.skills, "skill matches"]];
  for (const [count, name] of named) if (count) parts.push(`${name} ${count}`);
  return parts.length ? `harness · ${parts.join(" · ")}` : undefined;
}

export function createActivityIndicators(send: ActivitySender, pulse?: ActivityPulse): ActivityIndicators {
  let pulseCounts = emptyPulse(), pulseTimer: ReturnType<typeof setTimeout> | undefined, pulseShown: string | undefined;
  const flushPulse = () => {
    pulseTimer = undefined;
    const text = renderActivityPulse(pulseCounts);
    if (text === pulseShown) return;
    pulseShown = text;
    try { pulse?.set(text); } catch { /* UI can close first */ }
  };
  // Throttled: background helpers can fire many times a second.
  const touchPulse = () => { if (!pulse || pulseTimer) return; pulseTimer = setTimeout(flushPulse, 1200); pulseTimer.unref?.(); };
  const countPulse = (kind: string, data: Record<string, unknown>) => {
    if (!pulse || process.env.PI_SUBAGENT_CHILD === "1") return;
    const amount = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
    if (kind === "guardian.observing" || kind === "guardian.evaluated") {
      pulseCounts.guardianChecks = Math.max(pulseCounts.guardianChecks, amount(data.count) ?? 0);
      pulseCounts.guardianWasm = Math.max(pulseCounts.guardianWasm, amount(data.evaluations) ?? 0);
    } else if (kind === "guardian.decision") { pulseCounts.guardianVerdicts++; if (data.decision === "intervened") pulseCounts.guardianInterventions++; pulseCounts.guardianWasm = Math.max(pulseCounts.guardianWasm, amount(data.evaluations) ?? 0); }
    else if (kind === "ml.needle.call" && data.count !== 0) pulseCounts.needle++;
    else if (kind === "ml.jev.used") pulseCounts.jev++;
    else if (kind === "ml.fuzzy.used") pulseCounts.fuzzy++;
    else if (kind === "ml.radar.rank" && data.decision === "on") pulseCounts.ranker++;
    else if ((kind === "ml.smol.inference" || kind === "ml.local.inference") && (data.decision === "selected" || data.decision === "answered")) pulseCounts.local++;
    else if (kind === "hook.fired") pulseCounts.hooks++;
    else if (kind === "guidance.delivered") pulseCounts.hints++;
    else if (kind === "skill.route") pulseCounts.skills++;
    else return;
    touchPulse();
  };
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
  let generation = 0;
  let pendingFlush = false;
  const pendingIntelligence = new Map<string, { activity: DescribedActivity; count: number }>();
  const emitIntelligence = (activity: DescribedActivity, count: number): void => {
    const detail = [activity.detail, count > 1 ? `${count} ${activity.status === "skip" ? "events" : "completions"}` : undefined].filter(Boolean).join(" · ");
    lines++;
    try {
      const result = send({ customType: ACTIVITY_MESSAGE_TYPE, content: clean(`${activity.label} · ${detail}`, 240),
        display: true, excludeFromContext: true, details: { kind: "intelligence.activity", label: activity.label,
          status: activity.status, ...(activity.ms !== undefined ? { ms: activity.ms } : {}), detail, count } }, { triggerTurn: false });
      if (result && typeof (result as PromiseLike<unknown>).then === "function") (result as PromiseLike<unknown>).then(undefined, () => { dropped++; });
    } catch { dropped++; }
  };
  const queueIntelligence = (activity: DescribedActivity): void => {
    const key = `${activity.label}\0${activity.status}\0${activity.detail ?? ""}`;
    const existing = pendingIntelligence.get(key);
    if (existing) { existing.count++; if (activity.ms !== undefined) existing.activity.ms = (existing.activity.ms ?? 0) + activity.ms; }
    else if (pendingIntelligence.size < 64) pendingIntelligence.set(key, { activity: { ...activity }, count: 1 });
    else { dropped++; return; }
    if (pendingFlush) return;
    pendingFlush = true;
    const epoch = generation;
    queueMicrotask(() => {
      if (generation !== epoch) return;
      pendingFlush = false;
      const batch = [...pendingIntelligence.values()]; pendingIntelligence.clear();
      for (const item of batch) emitIntelligence(item.activity, item.count);
    });
  };

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
  sessionObservability()[ACTIVITY_VIEW] = counters;

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
      countPulse(kind, data);
      const visibleIntelligence = describeIntelligenceActivity(kind, data);
      const d = visibleIntelligence ?? describeActivity(kind, data);
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
      if (visibleIntelligence) {
        if (process.env.PI_SUBAGENT_CHILD === "1") return;
        // Ordering-only helpers are counted in the pulse; with a pulse there is
        // no transcript line for their routine success.
        if (PULSE_ONLY_INTELLIGENCE.has(kind) && visibleIntelligence.status === "ok" && pulse?.available()) return;
        // Eligibility checks and lexical ranking can run on every tool result.
        // Keep their full counters/ring, but repeat a stable status at most
        // once a minute (five minutes for routine Smol ineligibility). Actual
        // inference and context-delivery receipts remain individually visible.
        const cooldown = kind === "ml.smol.offer" && data.decision !== "cache-hit" ? 300_000
          : ["ml.fuzzy.used", "ml.jev.skipped", "ml.needle.skipped"].includes(kind) ? 60_000 : 0;
        if (cooldown) {
          const key = `intelligence\0${kind}\0${visibleIntelligence.status}\0${kind === "ml.fuzzy.used" ? "" : visibleIntelligence.detail}`;
          const last = lastLine.get(key);
          if (last !== undefined && now - last < cooldown) return;
          while (lineAt.length && now - lineAt[0]! > 60_000) lineAt.shift();
          if (lineAt.length >= LINE_BUDGET_PER_MIN) { dropped++; return; }
          lastLine.set(key, now); lineAt.push(now);
          if (lastLine.size > 512) lastLine.delete(lastLine.keys().next().value!);
        }
        queueIntelligence(visibleIntelligence);
        return;
      }
      const lineKind = kind;
      const lineLabel = d.label;
      const policy = LINE_POLICY[kind];
      if (!policy) return;
      // Output exhaustion is visible as a limit, without reporting a broken
      // model. Ordinary admission skips remain quiet.
      if (policy === "error" && d.status !== "error" && !(kind === "model.skip" && data.outcome === "length-stop")) return;
      // Child sessions have no TUI: lines would only bloat child context.
      if (process.env.PI_SUBAGENT_CHILD === "1") return;
      const lineStatus = d.status;
      const guardianState = lineKind.startsWith("guardian.") ? ["lazy", "initializing", "quarantined"].includes(String(data.decision)) ? String(data.decision) : "evaluating" : "";
      const key = `${lineKind}\0${lineLabel}\0${lineStatus}\0${guardianState}`;
      const last = lastLine.get(key);
      if (last !== undefined && now - last < dedupeMs(lineKind, lineStatus)) return;
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
            excludeFromContext: true,
            details: {
              kind: lineKind, label: lineLabel, status: lineStatus,
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
    generation++; pendingIntelligence.clear(); pendingFlush = false;
    pulseCounts = emptyPulse(); clearTimeout(pulseTimer); pulseTimer = undefined; pulseShown = undefined;
    try { pulse?.set(undefined); } catch { /* UI can close first */ }
    sessionObservability()[ACTIVITY_VIEW] = counters;
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
      generation++; pendingIntelligence.clear(); pendingFlush = false;
      clearTimeout(pulseTimer); pulseTimer = undefined;
      if (sessionObservability()[ACTIVITY_VIEW] === counters) {
        delete sessionObservability()[ACTIVITY_VIEW];
      }
    },
    snapshot: () => ring.slice(),
    counters,
  };
}

/** Transcript-line payload. The renderer paints from these details; the
 * corresponding custom message is explicitly excluded from LLM context. */
export interface ActivityDetails {
  count?: number;
  kind: string;
  label: string;
  status: ActivityStatus;
  ms?: number;
  detail?: string;
}

/** Short TUI tag per health kind; unknown kinds render in full. */
export const ACTIVITY_TAGS: Record<string, string> = {
  "guardian.observing": "Guardian",
  "guardian.evaluated": "Guardian",
  "guardian.decision": "Guardian",
  "hook.fired": "Hook",
  "skill.gate": "skill gate",
  "skill.route": "skill",
  "skill.read": "skill",
  "skill.resolve": "skill",
  "skill.rank": "skill",
  "skill.discovery": "skill",
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
};

/** In-process counters view for /metrics and /export-json. Undefined when the
 * health-log extension (the tap owner) has not started in this process. */
export function activityView(): ActivityCounters | undefined {
  try {
    const view = sessionObservability()[ACTIVITY_VIEW];
    return typeof view === "function" ? (view as () => ActivityCounters)() : undefined;
  } catch {
    return undefined;
  }
}
