// assistance-shadow — control-plane observation + marked-flow enforcement
// for subagent child launches (step 21; D-010, D-011).
//
// Tool-path launches (model/user-driven) shadow-observe only and are never
// refused. Marked harness flows (scope council, skill discovery, autonomous
// recovery) consult enforceAssistanceFlow once per flow id per canonical
// cycle; members share the grant. Runners have no request counter, so both
// paths use the shared control (D-011 contingency for assistance grants).
import { assistanceLaunchIntent } from "../../../../lib/intervention-intents.ts";
import { registerShadowSource } from "../../../../lib/intervention-registry.ts";
import { enforceFlow, getSharedSession, noteUserInput, sharedSourceAudit } from "../../../../lib/intervention-shared.ts";

export interface AssistanceLaunchInput {
  agent?: unknown; task?: unknown; model?: unknown; runId?: unknown; stepIndex?: unknown; mode?: unknown;
}

let registered = false;
function ensureRegistry(): void {
  if (registered) return;
  registered = true;
  try { registerShadowSource("assistance", () => sharedSourceAudit("pi-subagents.ts")); } catch { /* diagnostics only */ }
}

/** Journal what arbitration WOULD decide for one child launch. Never throws
 *  into the launch path: observation must not break spawning. */
export function shadowAssistanceLaunch(input: AssistanceLaunchInput): void {
  try {
    ensureRegistry();
    noteUserInput();
    getSharedSession().shadow(assistanceLaunchIntent(input));
  } catch {
    /* shadow observation never affects launch */
  }
}

/** Binding consult for ONE marked harness flow. The first member per flow
 *  id per cycle spends one helper unit; later members proceed under the
 *  grant. "refused" → the caller returns an advisory gap, never an error.
 *  Control failure fails OPEN (admit): enforcement must never break
 *  launching itself. */
export function enforceAssistanceFlow(flowId: string, input: AssistanceLaunchInput): "admitted" | "refused" {
  try {
    ensureRegistry();
    noteUserInput();
    return enforceFlow(flowId, assistanceLaunchIntent(input)).outcome === "admitted" ? "admitted" : "refused";
  } catch {
    return "admitted";
  }
}
