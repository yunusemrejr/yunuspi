/** Owned retry-policy constants. Folded from the retired retry-429-policy
 *  transform so live extensions never import scripts/compatibility. */
export const COOLDOWN_MS = 25_000;
export const WINDOW_MS = 120_000;
/** Cooldown-class pattern as a "/…/i" source string (same shape the retired
 *  transform embedded). Parse with `new RegExp(RATE_LIMIT_RE.slice(1,-2), "i")`
 *  or use `rateLimitRegExp()`. */
export const RATE_LIMIT_RE =
  "/\\b429\\b|\\b503\\b|rate.?limit|too many requests|service.?unavailable|temporar(?:ily)? unavailable|upstream_unavailable|json error injected into sse stream|stream_read_error|finish_reason: error/i";

export function rateLimitRegExp(): RegExp {
  return new RegExp(RATE_LIMIT_RE.replace(/^\//, "").replace(/\/i$/, ""), "i");
}


