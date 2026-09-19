// Shared by dispatch, child request caps and the checkpoint deadline. Tokens
// count cumulative input/output: reading source resends context on later turns.
export const AUTOMATIC_HELPER_LIMITS = { tools: 4, tokens: 48000, outputTokens: 4096 } as const;
// 2026-09-16: all-sessions audit showed 1426 unknown vs 4 changes vs 0 pass
// aspect outcomes and 0 accepted dispositions ever — 90s / $0.01 per round
// cannot cover free-tier turn latency (measured ~21s/turn × up to 8 tool
// turns) and paid fallback at $0.0033/reviewer fails instantly. Automatic
// rounds are now free-only (cost never binds); explicit reviews may spend
// paid up to the raised cap. Deadline covers ~8 slow turns + synthesis.
export const REVIEW_LIMITS = { rounds: 2, reviewers: 3, deadlineMs: 300000, costUsd: .05, tools: 8, toolsPerExtraAspect: 4, maxTools: 16, tokens: 96000, outputTokens: AUTOMATIC_HELPER_LIMITS.outputTokens } as const;
