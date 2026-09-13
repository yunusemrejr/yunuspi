// Shared by dispatch, child request caps and the checkpoint deadline. Tokens
// count cumulative input/output: reading source resends context on later turns.
export const AUTOMATIC_HELPER_LIMITS = { tools: 4, tokens: 48000, outputTokens: 4096 } as const;
export const REVIEW_LIMITS = { rounds: 2, reviewers: 3, deadlineMs: 90000, costUsd: .01, tools: 8, tokens: 96000, outputTokens: AUTOMATIC_HELPER_LIMITS.outputTokens } as const;
