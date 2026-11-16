# Decision-model comparison

**Decision.** Name the decision the model can make, the fallback, and the errors that would require escalation.

**Comparison.** Run the current path and the candidate on the same cases. Include ordinary cases, ambiguous input and an expensive failure. Keep the route, endpoint, effort, tool access and prompt version recorded. Separate cold and warm cache observations. Choose the smallest run that can expose the failure you care about.

**Evidence.** Record sample size, accepted outcomes, missed escalations, time to an accepted result and actual billed cost when available. Include every decision call, retry and fallback in the task total. Track subscription quota in its own units. Keep missing usage, billing and quota observations unknown.

**Decision rule.** Set a quality and latency threshold before the run. Compare cost per accepted result among configurations that meet it. Name the result that would justify reversing the decision and when to measure again.

## Local cost example

Run this after building the checkout's core or from an installed copy. It uses YunusPi's existing pricing function and sends no requests.

```sh
node agent/skills/operate/examples/route-cost.mjs --demo
node agent/skills/operate/examples/route-cost.mjs /path/to/normalized-cases.json
```

The input is an array of cases. Each has a `name` and `calls`. Each call has normalized `usage` buckets (`input`, `output`, `cacheRead`, and `cacheWrite`) and its captured `usdPerMillion` rates. A missing bucket or price can make a total unknown. Pass `knownFree: true` within the rates only with evidence that the call is free. Reasoning tokens already counted in output belong there once. Use per-call usage and rates so provider tiers apply to each invocation.

The demonstration prices and token counts are synthetic. Estimates are separate from invoice and quota measurements. Measure task quality and latency independently. The full session export can contain private prompts and paths, so use normalized rows with only the fields needed.
