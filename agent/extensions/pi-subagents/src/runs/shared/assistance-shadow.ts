// assistance-shadow — one control-plane shadow session for subagent child
// launches (foreground + background runners). Per-subsystem for the shadow
// phase; a shared control with canonical cycles arrives with go-live.
//
// Runners have no request counter at the spawn seam, so the session keeps
// one implicit cycle; per-record timestamps order launches. Evaluate-only:
// a launch is journaled, never gated.
import { createInterventionSession } from "../../../../lib/intervention-session.ts";
import { assistanceLaunchIntent } from "../../../../lib/intervention-intents.ts";

let session: ReturnType<typeof createInterventionSession> | null = null;

function getSession(): ReturnType<typeof createInterventionSession> {
  if (!session) session = createInterventionSession();
  return session;
}

/** Journal what arbitration WOULD decide for one child launch. Never throws
 *  into the launch path: observation must not break spawning. */
export function shadowAssistanceLaunch(input: {
  agent?: unknown; task?: unknown; model?: unknown; runId?: unknown; stepIndex?: unknown; mode?: unknown;
}): void {
  try {
    getSession().shadow(assistanceLaunchIntent(input));
  } catch {
    /* shadow observation never affects launch */
  }
}
