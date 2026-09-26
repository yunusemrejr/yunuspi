/** Expert Director — domain excellence coordination owned by one extension.
 * Registers the expert_director tool (brief/critics/assess/taste/status),
 * records bounded session entries for /metrics and /used, emits expert.*
 * health notes, and publishes a read-only inspector for micro_status.
 * The Director synthesizes signals; it never routes models, grants
 * permissions, or overrides safety, routing or completion owners. */
import { Type } from "typebox";
import { sessionObservability } from "./lib/session-observability.ts";
import { buildExpertBrief, expertEnabled, expertTasteWritable } from "./lib/expert-brief.ts";
import { EXPERT_DOMAIN_IDS, type ExpertDomainId } from "./lib/expert-domains.ts";
import { getDoctrinePack } from "./lib/expert-doctrine.ts";
import { buildCriticPlan } from "./lib/expert-critics.ts";
import { evaluateExpertConvergence, emptyExpertPassLedger, foldExpertPass, expertVerdictSummary } from "./lib/expert-convergence.ts";
import {
  readTasteStore, writeTasteStore, foldTastePreference, recallTaste, forgetTastePreference,
  type TasteProvenance, type TasteScope,
} from "./lib/expert-taste.ts";
import { resolveProjectIdentity } from "./lib/project-identity.ts";

const ENTRY = "expert-director-v1";
const INSPECT_KEY = Symbol.for("yunus-pi.micro.inspect.v1");

function noteHealth(kind: string, data: Record<string, unknown>): void {
  try { sessionObservability()[Symbol.for("yunus-pi.health.v1")]?.(kind, data); } catch { /* telemetry is optional */ }
}

const choices = (values: string[]) => Type.Union(values.map((value) => Type.Literal(value)));
const strList = (maxItems: number, maxLength: number) =>
  Type.Optional(Type.Array(Type.String({ maxLength }), { maxItems }));

export default function expertDirector(pi: any) {
  const runs: Array<{ at: number; action: string; domains: string[]; converged?: boolean; reason?: string }> = [];
  const ledgerBySession = new Map<string, ReturnType<typeof emptyExpertPassLedger>>();
  const record = (entry: (typeof runs)[number]) => {
    runs.push(entry);
    if (runs.length > 32) runs.splice(0, runs.length - 32);
  };
  // Read-only inspector for micro_status. Inspection never runs inference.
  try {
    const registry = ((globalThis as Record<symbol, unknown>)[INSPECT_KEY] ?? {}) as Record<string, unknown>;
    registry.expert = () => {
      try {
        const last = runs[runs.length - 1];
        return {
          status: expertEnabled() ? "ready" : "disabled",
          runs: runs.length,
          ...(last ? { last: { action: last.action, domains: last.domains, ...(last.reason ? { reason: last.reason } : {}) } } : {}),
        };
      } catch {
        return { status: "unavailable" };
      }
    };
    (globalThis as Record<symbol, unknown>)[INSPECT_KEY] = registry;
  } catch { /* Inspection is optional. */ }

  const projectId = (ctx: any): string => {
    try {
      return resolveProjectIdentity(ctx?.cwd || process.cwd()).id;
    } catch {
      return "";
    }
  };

  pi.registerTool({
    name: "expert_director",
    label: "Expert Director",
    description: "Domain-excellence coordination: infer excellence domains from a request, load bounded expert doctrine with quality priors, assemble read-only critic lenses, and evaluate improvement-loop convergence. brief infers domains and returns the advisory brief; critics returns the cheap-first lens plan; assess folds pass evidence into a convergence verdict; taste records/lists/forgets quality preferences (main session only); status reports recent Director activity. Advisory: user words and project conventions always win.",
    parameters: Type.Object({
      action: choices(["brief", "critics", "assess", "taste", "status"]),
      prompt: Type.Optional(Type.String({ maxLength: 32000, description: "Request text for brief inference; defaults to no forced brief." })),
      files: Type.Optional(Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 64, description: "Evidence paths shaping domain inference; never read here." })),
      domains: Type.Optional(Type.Array(Type.String({ maxLength: 32 }), { maxItems: 3, description: "Explicit domain ids for critics/assess; inferred when omitted." })),
      pass: Type.Optional(Type.Object({
        openRequirements: Type.Optional(Type.Array(Type.String({ maxLength: 16 }), { maxItems: 20 })),
        invariantViolations: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 12 })),
        failingChecks: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 12 })),
        openBlocking: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
        openImprovements: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
        openPolish: Type.Optional(Type.Integer({ minimum: 0, maximum: 200 })),
        fixedBlocking: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
        fixedImprovements: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
        newSubstantive: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
        pass: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
        maxPasses: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
        evidenceCurrent: Type.Optional(Type.Boolean()),
        unavailable: Type.Optional(Type.Array(Type.String({ maxLength: 120 }), { maxItems: 12 })),
      })),
      taste: Type.Optional(Type.Object({
        op: choices(["record", "list", "forget"]),
        text: Type.Optional(Type.String({ maxLength: 200 })),
        domains: Type.Optional(Type.Array(Type.String({ maxLength: 32 }), { maxItems: 8 })),
        scope: Type.Optional(choices(["user", "project"])),
        provenance: Type.Optional(choices(["explicit", "accepted", "rejected"])),
        selector: Type.Optional(Type.String({ maxLength: 200 })),
      })),
    }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: any) {
      signal?.throwIfAborted();
      if (!expertEnabled()) throw Error("Expert Director is disabled (PI_EXPERT=off).");
      const action = params?.action;
      if (action === "brief") {
        const brief = buildExpertBrief({
          prompt: typeof params.prompt === "string" ? params.prompt : "",
          files: Array.isArray(params.files) ? params.files.filter((f: unknown) => typeof f === "string").slice(0, 64) : [],
          projectId: projectId(ctx),
          force: true,
        });
        const sid = ctx?.sessionManager?.getSessionId?.() ?? "";
        try { pi.appendEntry?.(ENTRY, { at: Date.now(), session: sid, action: "brief", domains: brief.domains, taskType: brief.taskType, openEnded: brief.openEnded, detail: brief.detail }); } catch { /* entries are optional */ }
        record({ at: Date.now(), action: "brief", domains: brief.domains });
        noteHealth("expert.brief", { domains: brief.domains.join(","), taskType: brief.taskType, openEnded: brief.openEnded, count: 1 });
        const data = { qualified: brief.qualified, domains: brief.domains, taskType: brief.taskType, openEnded: brief.openEnded, brief: brief.text, summary: brief.summary, detail: brief.detail };
        return { content: [{ type: "text", text: JSON.stringify(data).slice(0, 6000) }], details: data };
      }
      if (action === "critics") {
        const domains = (Array.isArray(params.domains) ? params.domains : []).filter((d: unknown): d is ExpertDomainId =>
          typeof d === "string" && (EXPERT_DOMAIN_IDS as readonly string[]).includes(d)).slice(0, 3);
        const plan = buildCriticPlan(domains);
        const lenses = plan.lenses.map((l) => ({
          id: l.lens.id, role: l.lens.role, kind: l.lens.kind, owner: l.lens.owner,
          domains: l.domains, checks: [...l.lens.checks], evidence: l.lens.evidence,
          brief: l.lens.brief, evidencePacket: l.evidencePacket,
        }));
        try { pi.appendEntry?.(ENTRY, { at: Date.now(), action: "critics", domains, lenses: lenses.map((l) => l.id), dropped: plan.dropped }); } catch { /* optional */ }
        record({ at: Date.now(), action: "critics", domains });
        noteHealth("expert.critics", { lenses: lenses.length, dropped: plan.dropped.length, count: 1 });
        const data = { packs: plan.packs, lenses, deterministicFirst: plan.deterministicFirst, modelJudgment: plan.modelJudgment, dropped: plan.dropped };
        return { content: [{ type: "text", text: JSON.stringify(data).slice(0, 8000) }], details: data };
      }
      if (action === "assess") {
        const p = params.pass ?? {};
        const evidence = {
          openRequirements: Array.isArray(p.openRequirements) ? p.openRequirements.filter((s: unknown) => typeof s === "string") : [],
          invariantViolations: Array.isArray(p.invariantViolations) ? p.invariantViolations.filter((s: unknown) => typeof s === "string") : [],
          failingChecks: Array.isArray(p.failingChecks) ? p.failingChecks.filter((s: unknown) => typeof s === "string") : [],
          openBlocking: p.openBlocking ?? 0, openImprovements: p.openImprovements ?? 0, openPolish: p.openPolish ?? 0,
          fixedBlocking: p.fixedBlocking ?? 0, fixedImprovements: p.fixedImprovements ?? 0, newSubstantive: p.newSubstantive ?? 0,
          pass: p.pass ?? 1, maxPasses: p.maxPasses ?? 3, evidenceCurrent: p.evidenceCurrent !== false,
          unavailable: Array.isArray(p.unavailable) ? p.unavailable.filter((s: unknown) => typeof s === "string") : [],
        };
        const verdict = evaluateExpertConvergence(evidence);
        const sid = ctx?.sessionManager?.getSessionId?.() ?? "";
        const key = `${sid}`;
        const ledger = foldExpertPass(ledgerBySession.get(key) ?? emptyExpertPassLedger(evidence.maxPasses), verdict, evidence);
        ledgerBySession.set(key, ledger);
        try { pi.appendEntry?.(ENTRY, { at: Date.now(), session: sid, action: "assess", converged: verdict.converged, reason: verdict.reason, ledger }); } catch { /* optional */ }
        record({ at: Date.now(), action: "assess", domains: [], converged: verdict.converged, reason: verdict.reason });
        noteHealth("expert.assess", { converged: verdict.converged, reason: verdict.reason, count: 1 });
        const data = { ...verdict, summary: expertVerdictSummary(verdict), ledger };
        return { content: [{ type: "text", text: JSON.stringify(data).slice(0, 4000) }], details: data };
      }
      if (action === "taste") {
        const t = params.taste ?? {};
        const scope: TasteScope = t.scope === "project" ? "project" : "user";
        const pid = projectId(ctx);
        if (t.op === "list") {
          const prefs = recallTaste(readTasteStore("user"), readTasteStore("project", pid), pid,
            (Array.isArray(t.domains) ? t.domains : []).filter((d: unknown): d is ExpertDomainId => typeof d === "string"), 32);
          const data = { scope: "user+project", project: pid, preferences: prefs };
          return { content: [{ type: "text", text: JSON.stringify(data).slice(0, 6000) }], details: data };
        }
        if (!expertTasteWritable()) throw Error("Taste recording is main-session only; children stay read-only.");
        if (t.op === "record") {
          if (typeof t.text !== "string" || t.text.trim().length < 8) throw Error("Taste record needs an observable preference statement (≥8 chars).");
          const provenance: TasteProvenance = t.provenance === "accepted" || t.provenance === "rejected" ? t.provenance : "explicit";
          const store = readTasteStore(scope, pid);
          const { store: next, preference } = foldTastePreference(store, {
            scope, project: pid,
            domains: (Array.isArray(t.domains) ? t.domains : []).filter((d: unknown): d is ExpertDomainId =>
              typeof d === "string" && (EXPERT_DOMAIN_IDS as readonly string[]).includes(d)),
            text: t.text, provenance,
          });
          if (!writeTasteStore(scope, pid, next)) throw Error("Taste store write failed; preference not recorded.");
          try { pi.appendEntry?.(ENTRY, { at: Date.now(), action: "taste-record", scope, provenance, text: preference.text }); } catch { /* optional */ }
          record({ at: Date.now(), action: "taste-record", domains: preference.domains });
          noteHealth("expert.taste", { scope, provenance, count: 1 });
          const data = { recorded: preference };
          return { content: [{ type: "text", text: JSON.stringify(data).slice(0, 2000) }], details: data };
        }
        if (t.op === "forget") {
          if (typeof t.selector !== "string" || !t.selector.trim()) throw Error("Taste forget needs a selector (id prefix or exact text).");
          const store = readTasteStore(scope, pid);
          const { store: next, removed } = forgetTastePreference(store, t.selector);
          if (!removed) throw Error("No matching taste preference found.");
          if (!writeTasteStore(scope, pid, next)) throw Error("Taste store write failed; preference not forgotten.");
          const data = { forgotten: removed };
          return { content: [{ type: "text", text: JSON.stringify(data).slice(0, 2000) }], details: data };
        }
        throw Error("Taste needs op record|list|forget.");
      }
      if (action === "status") {
        const data = {
          enabled: expertEnabled(),
          runs: runs.slice(-12),
          packs: EXPERT_DOMAIN_IDS.map((id) => ({ id, lenses: getDoctrinePack(id)?.lenses.length ?? 0 })),
        };
        return { content: [{ type: "text", text: JSON.stringify(data).slice(0, 4000) }], details: data };
      }
      throw Error("Unknown expert_director action.");
    },
  });
}
