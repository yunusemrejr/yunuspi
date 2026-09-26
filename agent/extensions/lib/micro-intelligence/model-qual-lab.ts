/** Model qualification laboratory for newly discovered routes.
 *
 * New cheap/free OpenRouter routes appear faster than anyone can hand-test
 * them. The lab runs a bounded fixed battery over a candidate route —
 * tool selection, structured output, small coding/debugging, repository
 * navigation, instruction fidelity, requirement extraction, review
 * quality, long-context retrieval, tool-call validity — and measures
 * latency, tokens, cost and reliability plus privacy metadata. Results
 * qualify the route for specific roles with an EXPIRING eligibility, so
 * route selection improves from measurements instead of guesses.
 *
 * The lab never promotes a route by itself: it only records evidence.
 * Admission owners (micro-worker, routers) read eligibility as one input
 * among price/health/restriction gates.
 */
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { routePrivacyTier } from "./route-privacy.ts";

export type QualRole = "micro-worker" | "skill-router" | "coding-child" | "observer" | "quality-reviewer" | "main-fallback";

export const QUAL_ROLES: readonly QualRole[] = [
  "micro-worker", "skill-router", "coding-child", "observer", "quality-reviewer", "main-fallback",
];

export interface QualTask {
  id: string;
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
  /** Deterministic scorer over the raw response (0..1). */
  score: (response: string) => number;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

const hasJsonObject = (response: string): number => {
  try {
    const parsed: unknown = JSON.parse(response.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? 1 : 0;
  } catch {
    return 0;
  }
};

const mentionsAll = (...terms: string[]) => (response: string): number => {
  const lower = response.toLowerCase();
  const hits = terms.filter((term) => lower.includes(term.toLowerCase())).length;
  return terms.length ? hits / terms.length : 0;
};

/** Fixed bounded battery. Prompts are synthetic and fixture-stable. */
export function qualBattery(): QualTask[] {
  return [
    {
      id: "tool-selection",
      prompt: `Tools: read(path), bash(command), edit(path,old,new). Task: find where MAX_RETRIES is defined. Reply with JSON only: {"tool":"...","args":{}}.`,
      maxTokens: 200, timeoutMs: 30_000,
      score: (response) => {
        try {
          const parsed = JSON.parse(response) as { tool?: string };
          return parsed.tool === "bash" || parsed.tool === "read" ? 1 : 0.2 * hasJsonObject(response);
        } catch { return 0; }
      },
    },
    {
      id: "structured-output",
      prompt: `Reply with JSON only: {"name":"ada","ports":[80,443],"enabled":true}. No other text.`,
      maxTokens: 120, timeoutMs: 30_000,
      score: (response) => {
        try {
          const parsed = JSON.parse(response) as Record<string, unknown>;
          return parsed.name === "ada" && Array.isArray(parsed.ports) && parsed.ports.length === 2 && parsed.enabled === true ? 1 : 0.4;
        } catch { return 0; }
      },
    },
    {
      id: "coding-debug",
      prompt: `This function always returns 0. Say why in one sentence, then give the fixed line. function f(xs){let n=0;for(const x of xs){n=+1;}return n;}`,
      maxTokens: 200, timeoutMs: 45_000,
      score: mentionsAll("n = +1", "n += 1", "n++", "assigns"),
    },
    {
      id: "repo-navigation",
      prompt: `A repo has src/auth/login.ts, src/auth/session.ts, src/billing/invoice.ts. Which file most likely owns "refresh token rotation"? Reply with the path only.`,
      maxTokens: 60, timeoutMs: 30_000,
      score: (response) => response.includes("src/auth/session.ts") ? 1 : response.includes("src/auth/") ? 0.5 : 0,
    },
    {
      id: "instruction-fidelity",
      prompt: `List exactly three colors, one per line, lowercase, no numbering, no extra text.`,
      maxTokens: 60, timeoutMs: 30_000,
      score: (response) => {
        const lines = response.trim().split("\n").map((line) => line.trim()).filter(Boolean);
        if (lines.length !== 3) return 0;
        return lines.every((line) => /^[a-z]+$/.test(line)) ? 1 : 0.3;
      },
    },
    {
      id: "requirement-extraction",
      prompt: `Request: "Add dark mode, fix the login redirect, and never log passwords." Reply with JSON only: {"items":["...","...","..."]}.`,
      maxTokens: 200, timeoutMs: 30_000,
      score: (response) => {
        try {
          const parsed = JSON.parse(response) as { items?: unknown };
          if (!Array.isArray(parsed.items) || parsed.items.length !== 3) return 0;
          return mentionsAll("dark mode", "login redirect", "never log passwords")(parsed.items.join(" | "));
        } catch { return 0; }
      },
    },
    {
      id: "review-quality",
      prompt: `Review this change for a concrete defect (one paragraph): "replaced bcrypt.hash(password, 12) with md5(password) for speed".`,
      maxTokens: 250, timeoutMs: 45_000,
      score: mentionsAll("md5", "hash", "insecure", "bcrypt"),
    },
    {
      id: "long-context-retrieval",
      prompt: `Markers: alpha=11 bravo=22 charlie=33 delta=44 echo=55 foxtrot=66 golf=77 hotel=88. What is the value of echo? Reply with the number only.`,
      maxTokens: 20, timeoutMs: 30_000,
      score: (response) => response.trim() === "55" ? 1 : 0,
    },
    {
      id: "tool-call-validity",
      prompt: `Reply with JSON only: {"name":"read","arguments":{"path":"src/index.ts","offset":1,"limit":50}}. No other text.`,
      maxTokens: 150, timeoutMs: 30_000,
      score: (response) => {
        try {
          const parsed = JSON.parse(response) as { name?: string; arguments?: Record<string, unknown> };
          return parsed.name === "read" && parsed.arguments?.path === "src/index.ts" ? 1 : 0.4 * hasJsonObject(response);
        } catch { return 0; }
      },
    },
  ];
}

export interface QualComplete {
  (input: { route: string; prompt: string; maxTokens: number; timeoutMs: number; signal?: AbortSignal }): Promise<{
    text: string; latencyMs: number; inputTokens?: number; outputTokens?: number; costUsd?: number;
  }>;
}

export interface QualTaskResult {
  id: string;
  score: number;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error?: string;
}

export interface QualSummary {
  route: string;
  at: number;
  tasks: QualTaskResult[];
  meanScore: number;
  passRate: number;
  p95LatencyMs: number;
  totalCostUsd: number;
  reliability: number;
  privacyTier: string;
  privacyReason: string;
}

export const QUAL_PASS_SCORE = 0.6;

export async function runQualBattery(
  route: string,
  complete: QualComplete,
  opts: { signal?: AbortSignal; env?: Record<string, string | undefined>; tasks?: QualTask[] } = {},
): Promise<QualSummary> {
  const env = opts.env ?? process.env;
  const tasks = opts.tasks ?? qualBattery();
  const [provider, ...rest] = String(route).split("/");
  const privacy = routePrivacyTier(provider ?? "", rest.join("/") ?? "", env);
  const results: QualTaskResult[] = [];
  for (const task of tasks.slice(0, 16)) {
    if (opts.signal?.aborted) break;
    const started = Date.now();
    try {
      const answer = await complete({ route, prompt: task.prompt, maxTokens: task.maxTokens, timeoutMs: task.timeoutMs, signal: opts.signal });
      results.push({
        id: task.id,
        score: clamp01(task.score(answer.text ?? "")),
        latencyMs: answer.latencyMs ?? (Date.now() - started),
        inputTokens: answer.inputTokens ?? 0,
        outputTokens: answer.outputTokens ?? 0,
        costUsd: answer.costUsd ?? 0,
      });
    } catch (error) {
      results.push({
        id: task.id, score: 0, latencyMs: Date.now() - started,
        inputTokens: 0, outputTokens: 0, costUsd: 0,
        error: error instanceof Error ? error.message.slice(0, 120) : "failed",
      });
    }
  }
  const latencies = [...results.map((row) => row.latencyMs)].sort((a, b) => a - b);
  const passed = results.filter((row) => row.score >= QUAL_PASS_SCORE && !row.error).length;
  return {
    route,
    at: Date.now(),
    tasks: results,
    meanScore: results.length ? results.reduce((sum, row) => sum + row.score, 0) / results.length : 0,
    passRate: results.length ? passed / results.length : 0,
    p95LatencyMs: latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(0.95 * latencies.length))] : 0,
    totalCostUsd: results.reduce((sum, row) => sum + row.costUsd, 0),
    reliability: results.length ? results.filter((row) => !row.error).length / results.length : 0,
    privacyTier: privacy.tier,
    privacyReason: privacy.reason,
  };
}

/** Role thresholds over a battery summary. Unknown stays ineligible. */
export function qualifyForRole(summary: QualSummary, role: QualRole): { eligible: boolean; reason: string } {
  if (!summary.tasks.length) return { eligible: false, reason: "no-evidence" };
  const byId = new Map(summary.tasks.map((task) => [task.id, task]));
  const score = (id: string): number => byId.get(id)?.score ?? 0;
  switch (role) {
    case "micro-worker":
      return summary.meanScore >= 0.6 && summary.reliability >= 0.8
        ? { eligible: true, reason: "battery-pass" } : { eligible: false, reason: "below-bar" };
    case "skill-router":
      return score("tool-selection") >= 0.6 && score("instruction-fidelity") >= 0.6 && summary.reliability >= 0.8
        ? { eligible: true, reason: "battery-pass" } : { eligible: false, reason: "below-bar" };
    case "coding-child":
      return score("coding-debug") >= 0.6 && score("repo-navigation") >= 0.5 && score("tool-call-validity") >= 0.6 && summary.reliability >= 0.9
        ? { eligible: true, reason: "battery-pass" } : { eligible: false, reason: "below-bar" };
    case "observer":
      return score("review-quality") >= 0.5 && score("requirement-extraction") >= 0.6 && summary.reliability >= 0.9
        ? { eligible: true, reason: "battery-pass" } : { eligible: false, reason: "below-bar" };
    case "quality-reviewer":
      return score("review-quality") >= 0.75 && score("coding-debug") >= 0.6 && summary.reliability >= 0.9
        ? { eligible: true, reason: "battery-pass" } : { eligible: false, reason: "below-bar" };
    case "main-fallback":
      return summary.meanScore >= 0.8 && summary.reliability >= 0.95 && score("long-context-retrieval") >= 0.6
        ? { eligible: true, reason: "battery-pass" } : { eligible: false, reason: "below-bar" };
    default:
      return { eligible: false, reason: "unknown-role" };
  }
}

export interface EligibilityEntry {
  route: string;
  role: QualRole;
  eligible: boolean;
  reason: string;
  meanScore: number;
  reliability: number;
  privacyTier: string;
  at: number;
  expiresAt: number;
}

export const QUAL_ELIGIBILITY_TTL_MS = 7 * 86_400_000;

export function defaultQualStorePath(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDir, "micro-intel", "qual-eligibility.json");
}

export function createEligibilityStore(opts: { ttlMs?: number; file?: string; now?: () => number } = {}): {
  record: (summary: QualSummary, role: QualRole) => EligibilityEntry;
  get: (route: string, role: QualRole) => EligibilityEntry | undefined;
  snapshot: () => EligibilityEntry[];
  clear: () => void;
} {
  const ttlMs = opts.ttlMs ?? QUAL_ELIGIBILITY_TTL_MS;
  const now = opts.now ?? Date.now;
  const file = opts.file;
  const entries = new Map<string, EligibilityEntry>();
  const keyOf = (route: string, role: QualRole): string => `${role}/${route}`;
  const load = (): void => {
    if (!file) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as { entries?: EligibilityEntry[] };
      if (!Array.isArray(raw.entries)) return;
      for (const entry of raw.entries.slice(0, 256)) {
        if (entry && typeof entry.route === "string" && typeof entry.role === "string" && Number.isFinite(entry.expiresAt)) {
          entries.set(keyOf(entry.route, entry.role as QualRole), entry);
        }
      }
    } catch {
      /* Missing/corrupt store starts empty; qualification re-runs. */
    }
  };
  const persist = (): void => {
    if (!file) return;
    try {
      mkdirSync(join(file, ".."), { recursive: true });
      const tmp = `${file}.${randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify({ entries: [...entries.values()].slice(0, 256) }));
      renameSync(tmp, file);
    } catch {
      /* Persistence is best-effort; memory still serves this session. */
    }
  };
  load();
  const fresh = (entry: EligibilityEntry | undefined): EligibilityEntry | undefined =>
    entry && entry.expiresAt > now() ? entry : undefined;
  return {
    record(summary, role) {
      const verdict = qualifyForRole(summary, role);
      const entry: EligibilityEntry = {
        route: summary.route,
        role,
        eligible: verdict.eligible,
        reason: verdict.reason,
        meanScore: summary.meanScore,
        reliability: summary.reliability,
        privacyTier: summary.privacyTier,
        at: now(),
        expiresAt: now() + ttlMs,
      };
      entries.set(keyOf(summary.route, role), entry);
      persist();
      return entry;
    },
    get(route, role) {
      const entry = fresh(entries.get(keyOf(route, role)));
      if (!entry) entries.delete(keyOf(route, role));
      return entry;
    },
    snapshot() {
      return [...entries.values()].filter((entry) => entry.expiresAt > now());
    },
    clear() {
      entries.clear();
      persist();
    },
  };
}

export function qualFingerprint(summary: QualSummary): string {
  return createHash("sha256").update(JSON.stringify([summary.route, summary.tasks.map((task) => [task.id, task.score])])).digest("hex").slice(0, 16);
}
