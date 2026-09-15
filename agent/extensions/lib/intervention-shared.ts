// intervention-shared — the go-live singleton: ONE control, canonical
// request cycles, and per-cycle flow grants shared across extensions.
// State lives on globalThis under Symbol.for keys: pi loads every
// extension with a fresh jiti instance (moduleCache:false), so module-level
// singletons would fragment per extension (step-15 finding; same bridge as
// the shadow registry and the quality-review singletons).
//
// Budgets here are AUTOMATION budgets, never capability limits: only
// automatic (harness-initiated, unprompted) behavior consults this module.
// Explicit user/model/tool invocations never consult and are never refused.
import {
  createInterventionSession,
  type InterventionSession,
  type ShadowAudit,
  type ShadowRecord,
} from "./intervention-session.ts";
import type { InterventionDecision, InterventionIntent } from "./intervention-control.ts";

const SESSION_KEY = Symbol.for("yunuspi.shared-control.v1");
const CYCLE_KEY = Symbol.for("yunuspi.shared-cycle.v1");
const GRANTS_KEY = Symbol.for("yunuspi.shared-flow-grants.v1");

/** Input hooks on the same user request fire within milliseconds of each
 *  other; each must join the SAME canonical cycle. InputEvent carries no
 *  id, so reuse the open cycle inside this window, else open a new one. */
export const SHARED_CYCLE_WINDOW_MS = 1000;

type IntentInput = Omit<InterventionIntent, "requestId"> & { requestId?: string };

function store(): Record<PropertyKey, any> {
  return globalThis as any;
}

export function getSharedSession(): InterventionSession {
  const g = store();
  let session = g[SESSION_KEY] as InterventionSession | undefined;
  if (!session || typeof session.enforce !== "function") {
    session = createInterventionSession();
    g[SESSION_KEY] = session;
  }
  return session;
}

/** Join or open the canonical request cycle. Every subsystem's input hook
 *  calls this; hooks on the same request share the returned cycle. */
export function noteUserInput(now: number = Date.now()): string {
  const g = store();
  const open = g[CYCLE_KEY] as { cycle: string; openedAt: number } | undefined;
  const session = getSharedSession();
  if (open && open.cycle === session.control().currentCycle() && now - open.openedAt < SHARED_CYCLE_WINDOW_MS) {
    return open.cycle;
  }
  const cycle = session.beginRequest("shared-input");
  g[CYCLE_KEY] = { cycle, openedAt: now };
  g[GRANTS_KEY] = { cycle, ids: new Set<string>() };
  return cycle;
}

/** Binding consult against the shared control. The caller acts on the
 *  outcome (admitted → act, else skip with the receipt). Callers wrap in
 *  try/catch and fail OPEN (act) when the control is unreachable. */
export function enforceShared(intent: IntentInput): InterventionDecision {
  return getSharedSession().enforce(intent);
}

function grants(): { cycle: string | null; ids: Set<string> } {
  const g = store();
  let grants = g[GRANTS_KEY] as { cycle: string | null; ids: Set<string> } | undefined;
  const cycle = getSharedSession().control().currentCycle();
  if (!grants || grants.cycle !== cycle || !(grants.ids instanceof Set)) {
    grants = { cycle, ids: new Set<string>() };
    g[GRANTS_KEY] = grants;
  }
  return grants;
}

/** Flow-level enforcement for multi-launch harness flows (D-010): the first
 *  member consults and spends one budget unit; later members with the same
 *  flow id proceed under the grant without re-consulting. Returns the
 *  binding decision for the flow. Grants are not journaled here (the shared
 *  journal tracks consults); per-launch observation stays at the runner
 *  shadow seams. */
export function enforceFlow(flowId: string, intent: IntentInput): InterventionDecision {
  const id = typeof flowId === "string" && flowId ? flowId.slice(0, 160) : "flow";
  const g = grants();
  if (g.ids.has(id)) {
    const session = getSharedSession();
    const cycle = session.control().currentCycle() ?? session.beginRequest("implicit");
    return {
      outcome: "admitted",
      intentId: `grant:${id}`,
      requestId: cycle,
      category: intent.category,
      priority: typeof intent.priority === "number" ? intent.priority : 0,
      reason: `grant:${id}`,
      at: Date.now(),
    };
  }
  const decision = enforceShared(intent);
  if (decision.outcome === "admitted") g.ids.add(id);
  return decision;
}

/** Current-cycle audit slice for one source (registry readers for flipped
 *  subsystems). Shape matches ShadowAudit with enforced included. */
export function sharedSourceAudit(source: string): ShadowAudit {
  const session = getSharedSession();
  const cycle = session.control().currentCycle();
  const suppressed: Record<string, number> = {};
  const sources: Record<string, number> = {};
  let evaluated = 0;
  let admitted = 0;
  let enforced = 0;
  const journal: ShadowRecord[] = session.journal();
  for (const record of journal) {
    if (record.cycle !== cycle || record.source !== source) continue;
    evaluated++;
    if (record.outcome === "admitted") admitted++;
    else suppressed[record.outcome] = (suppressed[record.outcome] ?? 0) + 1;
    sources[record.source] = (sources[record.source] ?? 0) + 1;
    if (record.mode === "enforced") enforced++;
  }
  return { cycle, evaluated, admitted, suppressed, sources, enforced };
}

/** Test isolation only: production code never resets the shared control. */
export function resetSharedControl(): void {
  const g = store();
  delete g[SESSION_KEY];
  delete g[CYCLE_KEY];
  delete g[GRANTS_KEY];
}
