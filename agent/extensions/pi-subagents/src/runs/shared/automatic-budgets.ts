// Shared by dispatch, child request caps and the checkpoint deadline. Tokens
// count cumulative input/output: reading source resends context on later turns.
// reasoningOutputTokens is added to the per-response ceiling only when the
// request enables provider reasoning: thinking shares the output allowance, and
// a 4096 total truncated high-effort reviewers before their JSON verdict.
// One investigation can require four sequential tool turns plus synthesis.
// The deadline covers that work even on a slower reasoning provider; token,
// tool and cost limits still bound how much work it may perform.
export const AUTOMATIC_HELPER_LIMITS = { deadlineMs: 180_000, cleanupGraceMs: 5_000, tools: 4, tokens: 48000, outputTokens: 4096, reasoningOutputTokens: 8192 } as const;
// 2026-09-16: all-sessions audit showed 1426 unknown vs 4 changes vs 0 pass
// aspect outcomes and 0 accepted dispositions ever — 90s / $0.01 per round
// cannot cover free-tier turn latency (measured ~21s/turn × up to 8 tool
// turns) and paid fallback at $0.0033/reviewer fails instantly. Automatic
// rounds are now free-only (cost never binds); explicit reviews may spend
// paid up to the raised cap. Deadline covers ~8 slow turns + synthesis.
// stragglerMs: once a peer reviewer has finished, the others get at least
// this long, or 1.5x the slowest finished peer, before they are stopped. One
// dead leg held a 5-minute round (43% of a session's tool wall) after its two
// peers finished in about 90 seconds.
// failoverMinMs: a stopped or failed leg is re-run once on a peer route that
// already returned a validated review, only when at least this much of the
// round deadline remains (a healthy reviewer answers in about a minute).
export const REVIEW_LIMITS = { rounds: 2, reviewers: 3, deadlineMs: 300000, stragglerMs: 90000, failoverMinMs: 45000, costUsd: .05, tools: 8, toolsPerExtraAspect: 4, maxTools: 16, tokens: 96000, outputTokens: AUTOMATIC_HELPER_LIMITS.outputTokens } as const;
