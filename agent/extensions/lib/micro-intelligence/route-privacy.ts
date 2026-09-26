/** Route privacy tiers for cheap-remote-model admission.
 *
 * A route being free (or cheap) says nothing about where prompts go or how
 * long they are retained. Micro-worker, qualification and rerank admission
 * therefore consult this module before sending private repository content
 * to a remote route. Tiers are conservative by construction:
 *
 * - "local": the request never leaves this host (loopback model servers).
 * - "allowed": the operator explicitly asserted the exact route is safe for
 *   private content via PI_PRIVATE_ROUTES.
 * - "unknown": everything else. Unknown is never safe for private content.
 *
 * No inference, no I/O; pure classification over caller-supplied facts.
 */

export type RoutePrivacyTier = "local" | "allowed" | "unknown";

export interface RoutePrivacyVerdict {
  tier: RoutePrivacyTier;
  /** Short machine-readable reason (safe for metrics/health surfaces). */
  reason: string;
}

/** Provider ids that serve from this host. Loopback transports only. */
const LOCAL_PROVIDER_PATTERN = /^(?:lm-?studio|ollama|llama-?cpp|local(?:-.+)?|yunuspi-local)$/i;

/** Parse PI_PRIVATE_ROUTES="provider/model,provider/model" into exact entries. */
export function parsePrivateRouteAllowlist(value: unknown): Set<string> {
  const out = new Set<string>();
  if (typeof value !== "string") return out;
  for (const entry of value.split(",")) {
    const clean = entry.trim().toLowerCase().replace(/\s+/g, "");
    if (!clean || clean.length > 160 || !clean.includes("/")) continue;
    if (out.size >= 64) break;
    out.add(clean);
  }
  return out;
}

export function routePrivacyTier(
  provider: unknown,
  model: unknown,
  env: Record<string, string | undefined> = process.env,
): RoutePrivacyVerdict {
  const providerText = typeof provider === "string" ? provider.trim() : "";
  const modelText = typeof model === "string" ? model.trim() : "";
  if (LOCAL_PROVIDER_PATTERN.test(providerText)) {
    return { tier: "local", reason: "loopback-provider" };
  }
  const allowlist = parsePrivateRouteAllowlist(env.PI_PRIVATE_ROUTES);
  const key = `${providerText}/${modelText}`.toLowerCase();
  if (providerText && modelText && allowlist.has(key)) {
    return { tier: "allowed", reason: "operator-allowlist" };
  }
  return { tier: "unknown", reason: allowlist.size ? "not-allowlisted" : "no-privacy-evidence" };
}

/** True only for local or operator-allowlisted routes. Unknown stays unsafe. */
export function routeSafeForPrivateRepo(
  provider: unknown,
  model: unknown,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return routePrivacyTier(provider, model, env).tier !== "unknown";
}
