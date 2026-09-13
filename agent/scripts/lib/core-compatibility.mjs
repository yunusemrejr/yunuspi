// Synthetic offline release checks; never import private histories or fixtures.
export const CORE_COMPATIBILITY_TESTS = Object.freeze([
  "harness-load-test.mjs",
  "retry-lifecycle-test.mjs",
  "summary-recovery-test.mjs",
  "automatic-compaction-test.mjs",
  "hook-lifecycle-integrity-test.mjs",
  "tool-integrity-test.mjs",
  "skill-pack-routing-test.mjs",
  "reasoning-aids-loader-test.mjs",
  "utility-mcp-loader-test.mjs",
  "session-recovery-guidance-test.mjs",
  "autonomous-recovery-test.mjs",
  "atomic-edit-preflight-test.mjs"
]);
