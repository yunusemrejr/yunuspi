import {
  PI_TOKEN_BUDGET_CEILING,
  PI_TOKEN_BUDGET_SCALE,
} from "./token-budget.ts";
import {
  automaticCompactionThreshold,
  compactionSettingsForWindow,
} from "./compaction-policy.ts";
export function pressureFacts(
  ctx: any,
  settings: any,
  requestedOutput?: number,
) {
  const usage = ctx.getContextUsage(),
    window = ctx.model?.contextWindow;
  const runtimeSettings = usage?.compactionSettings;
  if (!Number.isFinite(window) || window <= 0)
    return {
      available: false,
      reason: "Active model context window unavailable",
    };
  // `maxContextTokens` was a transport cap used by an older compaction
  // policy. It must not shape diagnostics now that the selected model's full
  // context window owns the automatic trigger. Keep the returned settings
  // useful for the remaining reserve/tail fields, but remove that legacy
  // input before window normalization so it cannot affect this report.
  const suppliedSettings = runtimeSettings ?? settings ?? {};
  const policySettings = { ...suppliedSettings };
  delete policySettings.maxContextTokens;
  settings = compactionSettingsForWindow(window, policySettings);
  const rawTokens = usage?.tokens;
  const tokens = Number.isFinite(rawTokens) && rawTokens >= 0 ? rawTokens : null;
  const output =
    requestedOutput ??
    Math.min(
      ctx.model?.maxTokens ?? PI_TOKEN_BUDGET_CEILING,
      PI_TOKEN_BUDGET_CEILING,
      Math.max(128, Math.floor(window / 4)),
    );
  const safety = Math.max(
    Math.min(PI_TOKEN_BUDGET_SCALE, Math.max(128, Math.floor(window / 8))),
    Math.ceil((tokens ?? 0) * 0.05),
  );
  // Output and safety reservations describe request headroom only. They are
  // intentionally separate from the full-window automatic-compaction gate.
  const usable = Math.max(0, window - output - safety);
  const contextWindowPercent =
    tokens === null ? null : (tokens / window) * 100;
  const usablePercent =
    tokens === null
      ? null
      : usable
        ? (tokens / usable) * 100
        : tokens > 0
          ? 100
          : 0;
  const compactionTrigger = settings.enabled
    ? automaticCompactionThreshold(tokens ?? 0, window, settings)
    : null;
  return {
    available: tokens !== null,
    model: `${ctx.model.provider}/${ctx.model.id}`,
    tokens,
    usageKind: "SDK estimate (last measured usage plus trailing estimates)",
    contextWindow: window,
    outputReservation: output,
    outputSource:
      requestedOutput === undefined
        ? "window-bounded output allowance; actual request unavailable"
        : "observed provider request",
    safetyReservation: safety,
    // Kept as a compatibility alias. Automatic compaction has one policy
    // value now: the inclusive full-window trigger below.
    compaction: compactionTrigger,
    compactionTrigger,
    contextWindowPercent,
    // `percent` is the model-facing pressure metric. Keep usable headroom
    // available for diagnostics without letting it drive pressure notices.
    percent: contextWindowPercent,
    usablePercent,
    compactionSettings: settings,
    settingsSource: runtimeSettings
      ? "active runtime settings"
      : "persisted settings fallback; run verify-harness --fix and restart for runtime settings",
    usableBudget: usable,
    remaining: tokens === null ? null : Math.max(0, usable - tokens),
    overBudgetTokens: tokens === null ? null : Math.max(0, tokens - usable),
  };
}
export function payloadPressureWarning(
  contextWindowPercent: number | null | undefined,
) {
  return contextWindowPercent != null && contextWindowPercent >= 90
    ? "[tool payload risk] Context is at least 90% of the selected model context window. While context remains this full, large write/edit/bash arguments are at increased risk of malformed JSON, corrupted paths, or repetitive content. Prefer small targeted calls, put path first, and read back changed regions. Preserve the current goal, decisions, evidence locations and next step before compaction, then continue. Compaction is routine; do not skip required work or verification to avoid it. This warning does not save or verify files."
    : undefined;
}
export interface OutputRequest {
  provider: string;
  model: string;
  cap?: number;
  configuredCap?: number;
}
export function truncationDiagnostic(message: { provider: string; model: string }, request?: OutputRequest) {
  const matched = request?.provider === message.provider && request?.model === message.model ? request : undefined;
  return `Response was truncated before completion — ${message.provider}/${message.model}; request-hook maxTokens=${matched?.cap ?? "unavailable"}; configured model maxTokens=${matched?.configuredCap ?? "unavailable"}. This cap was observed at the hook, not attested from the final wire payload; later payload hooks and harness/context policy may change it. Backend limits may also apply. A length stop does not establish the provider's supported maximum.`;
}
export class PressureThresholds {
  levels: number[];
  armed = new Set<number>();
  constructor(levels = [70, 85]) {
    this.levels = levels
      .filter((n) => Number.isFinite(n) && n > 0 && n < 100)
      .sort((a, b) => a - b);
    this.reset();
  }
  reset() {
    this.armed = new Set(this.levels);
  }
  observe(percent: number | null) {
    if (percent === null) return null;
    for (const n of this.levels) if (percent < n - 5) this.armed.add(n);
    const crossed = this.levels.filter(
      (n) => percent >= n && this.armed.has(n),
    );
    for (const n of crossed) this.armed.delete(n);
    return crossed.at(-1) ?? null;
  }
}
export function dateAnchor(
  now = new Date(),
  timezone = process.env.PI_TIMEZONE,
) {
  let zone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    source = timezone ? "PI_TIMEZONE" : "system fallback";
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format(now);
  } catch {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    source = "system fallback (invalid PI_TIMEZONE)";
  }
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return {
    key: `${date}/${zone}`,
    text: `[runtime date] ${date}; timezone ${zone} (${source}). Runtime clock, not historical filenames.`,
  };
}
export function sessionFacts(entries: any[]) {
  let input = 0,
    output = 0,
    cacheRead = 0,
    cacheWrite = 0,
    missingUsage = 0,
    assistantAttempts = 0,
    assistantFailures = 0,
    cancellations = 0,
    summaryCalls = 0;
  const missingUsageFields = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  const calls = new Set(),
    results = new Map();
  for (const e of entries) {
    const m = e.type === "message" ? e.message : null;
    if (m?.role === "assistant") {
      assistantAttempts++;
      if (m.stopReason === "error") assistantFailures++;
      if (m.stopReason === "aborted") cancellations++;
      for (const c of m.content ?? [])
        if (c.type === "toolCall") calls.add(c.id);
    }
    if (m?.role === "toolResult") results.set(m.toolCallId, m);
    const summary = ["compaction", "branch_summary"].includes(e.type);
    if (summary) summaryCalls++;
    const reported =
      m?.role === "assistant" ? m.usage : summary ? e.usage : null;
    // Pi initializes all-zero Usage before a provider reports anything.
    const placeholder =
      m?.role === "assistant" &&
      reported &&
      reported.cacheReadReported !== true &&
      ["input", "output", "cacheRead", "cacheWrite"].every(
        (key) => reported[key] === 0,
      );
    const u = placeholder ? null : reported;
    if (m?.role === "assistant" || summary) {
      if (!u) missingUsage++;
      const valid = (key: string) => Number.isFinite(u?.[key]) && u[key] >= 0 &&
        !(key === "cacheRead" && u.cacheReadReported === false);
      for (const key of Object.keys(missingUsageFields)) {
        if (!valid(key)) missingUsageFields[key]++;
      }
      input += valid("input") ? u.input : 0;
      output += valid("output") ? u.output : 0;
      cacheRead += valid("cacheRead") ? u.cacheRead : 0;
      cacheWrite += valid("cacheWrite") ? u.cacheWrite : 0;
    }
  }
  const toolFailures = [...results.values()].filter(
    (m: any) => m.isError,
  ).length;
  return {
    scope:
      "current session file, all branches; unique persisted entries (resume/replay not added)",
    input,
    output,
    cacheRead,
    cacheWrite,
    missingUsage,
    missingUsageFields,
    totalsComplete: Object.values(missingUsageFields).every((n) => n === 0),
    assistantAttempts,
    assistantFailures,
    cancellations,
    toolCalls: calls.size,
    toolResults: results.size,
    toolFailures,
    toolErrorRate: results.size ? toolFailures / results.size : null,
    assistantErrorRate: assistantAttempts
      ? assistantFailures / assistantAttempts
      : null,
    summaryCalls,
    notes:
      "Token sums are reported partial totals when missingUsageFields is nonzero (unavailable is not zero). summaryCalls counts recorded compaction/branch-summary entries, not hidden retries. Input/output exclude separately reported caches. Error rates: error assistant attempts/all persisted assistant attempts; error tool results/all unique completed tool results. Aborted assistant attempts counted separately, included denominator. Provider-internal retries/unrecorded cancelled tools unavailable. Summary usage included when recorded; subagent and nested tool usage excluded, not provider-wide totals.",
  };
}
