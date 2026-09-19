/** Unified micro-intelligence health. Compact visibility over the five
 * layers for existing diagnostics surfaces (/diagnostics, session report).
 * Getters are injected so this module stays dependency-free and testable.
 */
export interface LayerHealth {
  layer: "deterministic" | "needle" | "smol" | "kompress" | "jev";
  /** One of: ready, warming, unavailable, disabled, busy, breaker-open, no-key. */
  status: string;
  detail: string;
}

export interface MicroHealth {
  layers: LayerHealth[];
  /** True when at least one helper layer can serve beyond deterministic. */
  assisted: boolean;
  at: number;
}

export function microHealthSnapshot(layers: LayerHealth[]): MicroHealth {
  return {
    layers,
    assisted: layers.some((layer) => layer.layer !== "deterministic" && ["ready", "warming", "busy"].includes(layer.status)),
    at: Date.now(),
  };
}

/** Render the compact block diagnostics surfaces embed. */
export function renderMicroHealth(health: MicroHealth): string {
  const lines = ["micro-intelligence:"];
  for (const layer of health.layers) {
    lines.push(`  ${layer.layer}: ${layer.status}${layer.detail ? ` (${layer.detail})` : ""}`);
  }
  return lines.join("\n");
}

/** Map a Needle health state to the shared vocabulary. */
export function needleStatus(state: string): string {
  switch (state) {
    case "healthy":
      return "ready";
    case "degraded":
      return "ready";
    case "warming":
      return "warming";
    case "disabled":
      return "disabled";
    case "cooling":
      return "breaker-open";
    default:
      return "unavailable";
  }
}

/** Map a Jev breaker state to the shared vocabulary. */
export function jevStatus(breakerOpen: boolean, hasKey: boolean): string {
  if (!hasKey) return "no-key";
  return breakerOpen ? "breaker-open" : "ready";
}
