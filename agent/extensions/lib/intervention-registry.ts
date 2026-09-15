// intervention-registry — one process-wide rollup of control-plane shadow
// audits. Each wired subsystem registers its session's audit reader at
// creation; diagnostics (session_self view "shadow") read the combined
// report. Read-only and total: a failing source reports null, never throws.
//
// Pure and additive: no pi imports, no I/O. Last registration wins per
// source name (factories may be re-created; tests isolate via clear).
import type { ShadowAudit } from "./intervention-session.ts";

type AuditReader = () => ShadowAudit | null;

const sources = new Map<string, AuditReader>();

export function registerShadowSource(name: string, readAudit: AuditReader): void {
  if (typeof name !== "string" || !name || typeof readAudit !== "function") return;
  sources.set(name.slice(0, 64), readAudit);
}

export function shadowReport(): { at: number; sources: Record<string, ShadowAudit | null> } {
  const out: Record<string, ShadowAudit | null> = {};
  for (const [name, read] of sources) {
    try {
      out[name] = read();
    } catch {
      out[name] = null;
    }
  }
  return { at: Date.now(), sources: out };
}

/** Test isolation only: production code never clears the registry. */
export function clearShadowSources(): void {
  sources.clear();
}
