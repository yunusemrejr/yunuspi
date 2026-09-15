// intervention-registry — one process-wide rollup of control-plane shadow
// audits. Each wired subsystem registers its session's audit reader at
// creation; diagnostics (session_self view "shadow") read the combined
// report. Read-only and total: a failing source reports null, never throws.
//
// The store lives on globalThis under a Symbol.for key: pi loads every
// extension with a fresh jiti instance (moduleCache:false), so module-level
// state is per-extension and imports alone cannot share it. Same bridge as
// the quality-review runner/context singletons. Last registration wins per
// source name (factories may be re-created; tests isolate via clear).
import type { ShadowAudit } from "./intervention-session.ts";

type AuditReader = () => ShadowAudit | null;

const REGISTRY_KEY = Symbol.for("yunuspi.shadow-registry.v1");

function sources(): Map<string, AuditReader> {
  const g = globalThis as any;
  let map = g[REGISTRY_KEY] as Map<string, AuditReader> | undefined;
  if (!(map instanceof Map)) {
    map = new Map<string, AuditReader>();
    g[REGISTRY_KEY] = map;
  }
  return map;
}

export function registerShadowSource(name: string, readAudit: AuditReader): void {
  if (typeof name !== "string" || !name || typeof readAudit !== "function") return;
  sources().set(name.slice(0, 64), readAudit);
}

export function shadowReport(): { at: number; sources: Record<string, ShadowAudit | null> } {
  const out: Record<string, ShadowAudit | null> = {};
  for (const [name, read] of sources()) {
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
  sources().clear();
}
