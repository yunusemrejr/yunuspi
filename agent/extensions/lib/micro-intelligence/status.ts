/** Micro-intelligence status snapshot for the read-only micro_status tool
 * and diagnostics surfaces. Gathers live helper state without running
 * inference: no embeddings, no judgments, no side effects.
 */
import { readFileSync } from "node:fs";
import { needleHealth, needleHandle } from "../needle-runtime.ts";
import { jevHealth, jevEnabled, JEV_INPUT_POLICY, JEV_MAX_INPUT_CHARS, JEV_REMOTE_PROVIDER, openRouterKey } from "../jev-client.ts";
import { microMetrics } from "./metrics.ts";
import { microHealthSnapshot, needleStatus, jevStatus, type LayerHealth } from "./health.ts";

const INSPECT_KEY = Symbol.for("yunus-pi.micro.inspect.v1");

/** Read build provenance from the package actually resolved by this harness. */
export function activeCoreIdentity(): Record<string, unknown> {
  try {
    const entry = import.meta.resolve("@yunuspi/coding-agent");
    const manifest = JSON.parse(readFileSync(new URL("../package.json", entry), "utf8"));
    if (manifest.name !== "@yunuspi/coding-agent") return { status: "unowned" };
    const receipt = JSON.parse(readFileSync(new URL("../../build.json", entry), "utf8"));
    if (receipt.releaseAuthority !== "yunusemrejr/yunuspi" || receipt.version !== manifest.version)
      return { status: "mismatch" };
    return { status: "owned", version: receipt.version, origin: { project: receipt.forkOrigin?.project, version: receipt.forkOrigin?.version, commit: receipt.forkOrigin?.commit },
      sourceCommit: receipt.sourceCommit ?? null, sourceDigest: receipt.sourceDigest,
      releaseAuthority: receipt.releaseAuthority, updatePolicy: receipt.updatePolicy };
  } catch { return { status: "unavailable" }; }
}


function registry(): Record<string, () => unknown> {
  try {
    return ((globalThis as Record<symbol, unknown>)[INSPECT_KEY] ?? {}) as Record<string, () => unknown>;
  } catch {
    return {};
  }
}

function safeInspect(name: string): unknown {
  try {
    const fn = registry()[name];
    if (typeof fn !== "function") return { status: "unknown" };
    return fn() ?? { status: "unknown" };
  } catch {
    return { status: "unavailable" };
  }
}

function smolStatus(inspect: unknown): string {
  if (!inspect || typeof inspect !== "object") return "unknown";
  const value = inspect as Record<string, unknown>;
  if (["unknown", "unavailable", "disabled", "busy", "ready"].includes(String(value.status))) return String(value.status);
  if (typeof value.busy === "boolean") return value.busy ? "busy" : "ready";
  return "ready";
}

export interface MicroStatusRequest {
  family: string;
  substantive: boolean;
  terms: string[];
  needle?: { score: number; margin: number; accepted: boolean } | { pending: true };
  advisory?: {
    ok: boolean;
    needsVerification: boolean;
    reviewWorthy: boolean;
    multiPerspective: boolean;
    perspectives: string[];
  } | { pending: true };
  promptAnalysis?: { kind: "initial" | "followup"; source: "model" | "fallback"; confidence: number; taskLabel: string };
}

export function microStatusSnapshot(request?: {
  family: string;
  substantive: boolean;
  terms: string[];
  needle?: { score: number; margin: number; accepted: boolean };
  needlePending?: boolean;
  advisory?: MicroStatusRequest["advisory"];
  advisoryPending?: boolean;
  advisoryFamily?: string;
  promptAnalysis?: MicroStatusRequest["promptAnalysis"];
}): Record<string, unknown> {
  const needle = needleHealth();
  const stats = needleHandle().stats();
  const jev = jevHealth();
  const hasKey = openRouterKey() !== undefined;
  const smol = safeInspect("smol");
  const kompress = safeInspect("mini");
  const layers: LayerHealth[] = [
    { layer: "deterministic", status: "ready", detail: "local reflexes" },
    {
      layer: "needle",
      status: needleStatus(needle.state),
      detail: needle.state === "healthy" || needle.state === "degraded"
        ? `dim ${needle.dim}, ${stats.calls} calls`
        : needle.lastError || needle.state,
    },
    { layer: "smol", status: smolStatus(smol), detail: "" },
    { layer: "kompress", status: smolStatus(kompress), detail: "" },
    {
      layer: "jev",
      status: jevStatus(jev.state === "open", hasKey),
      detail: jev.slug ?? jev.lastError,
    },
  ];
  return {
    core: activeCoreIdentity(),
    health: microHealthSnapshot(layers),
    request: request
      ? {
          family: request.family,
          substantive: request.substantive,
          terms: request.terms.slice(0, 16),
          needle: request.needle ?? (request.needlePending ? { pending: true } : undefined),
          advisory: request.advisory ?? (request.advisoryPending ? { pending: true } : undefined),
          ...(request.advisoryFamily ? { advisoryFamily: request.advisoryFamily } : {}),
          ...(request.promptAnalysis ? { promptAnalysis: request.promptAnalysis } : {}),
        }
      : null,
    needle: {
      state: needle.state,
      dim: needle.dim,
      uptimeMs: needle.uptimeMs,
      workerRestarts: needle.workerRestarts,
      queued: needle.queued,
      shadow: needle.shadow,
      calls: stats.calls,
      byOp: { embed: stats.embedCalls, rank: stats.rankCalls, classify: stats.classifyCalls, extract: stats.extractCalls },
      cacheHits: stats.cacheHits,
      coalescedCalls: stats.coalescedCalls,
      p50: stats.p50,
      p95: stats.p95,
      skipReasons: stats.skipReasons,
    },
    jev: {
      state: jev.state,
      slug: jev.slug ?? null,
      lastError: jev.lastError,
      key: hasKey,
      enabled: jevEnabled(),
      provider: JEV_REMOTE_PROVIDER,
      transport: "remote",
      inputPolicy: JEV_INPUT_POLICY,
      maxInputChars: JEV_MAX_INPUT_CHARS,
      disable: "PI_JEV=off",
    },
    smol,
    kompress,
    metrics: microMetrics().summaryLines(),
  };
}
