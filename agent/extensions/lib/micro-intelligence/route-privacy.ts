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

/** A provider label is not transport evidence. Require a literal loopback
 * address; DNS names and redirects cannot establish on-host privacy. */
export function isLoopbackModelUrl(value: unknown): boolean {
  try {
    if (typeof value !== 'string') return false;
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && (url.hostname === '127.0.0.1' || url.hostname === '[::1]');
  } catch { return false; }
}

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
  baseUrl?: string,
): RoutePrivacyVerdict {
  const providerText = typeof provider === "string" ? provider.trim() : "";
  const modelText = typeof model === "string" ? model.trim() : "";
  if (isLoopbackModelUrl(baseUrl)) {
    return { tier: "local", reason: "loopback-endpoint" };
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
  baseUrl?: string,
): boolean {
  return routePrivacyTier(provider, model, env, baseUrl).tier !== "unknown";
}
