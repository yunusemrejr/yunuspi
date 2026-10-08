# Testing YunusPi

Run `npm ci --ignore-scripts --no-audit --no-fund` once after dependency changes.

| Check | Command | Use |
| --- | --- | --- |
| Routine | `npm run test:quick` | Short core, cancellation, provider, memory, review, goal, release and mirror checks |
| Focused | `npm test -- tests/goal-state.test.mjs` | One or more explicit regression files |
| Routine plus focused | `npm run test:quick -- tests/image-generate.test.mjs` | Short catalogue plus the behavior being edited |
| Complete | `npm test` | Every root `tests/*.test.mjs`, including native integrations and full source parsing |
| Inventory | `node scripts/test.mjs --quick --list` | Inspect the short catalogue without building or executing tests |

The runner uses Node's test isolation, a two-minute default test timeout, a fifteen-minute run limit, and an isolated temporary directory that is removed after the run. Existing tests can set their own deadlines. Default parallelism is at most four; `PI_PUBLIC_TEST_CONCURRENCY=1` lowers it for small hosts. Explicit overrides from 1 to 16 remain available for measured publication runs. Native name filters, reporters, timeout overrides and coverage flags remain available, for example `npm test -- tests/goal-state.test.mjs --test-name-pattern=budget`. No new test framework or dependencies are required.

Ordinary PRs and main updates run the short catalogue and added/modified test files. This is a smoke and focused regression check, not full coverage of unchanged tests. Edit the relevant regression tests with implementation changes; run the complete suite when a change has wider effects. Deleted test files are excluded. Shared core/build/dependency/configuration, public safeguard, test helper and native integration changes automatically select the full distribution job. Unknown or unavailable Git baselines also select everything.

CI checks public history, release consistency, generated capability freshness, changed-source parsing and all three existing efficiency benchmarks. Native browser, media and sandbox prerequisites are installed only for the full job. Full checks run every Sunday at 05:17 Europe/Istanbul and when **Run workflow** is selected; scheduled execution can be delayed by GitHub. Releases accept only a successful full `safety` job on the same main commit, including an explicit manual or recurring run. PR evidence and a skipped full job cannot authorize a release.

Keep the quick catalogue small in `scripts/test.mjs`. Register a regression there only when it protects a broadly shared contract and runs without optional applications. The complete file list is discovered automatically, so new tests cannot fall out of full checks because a list was forgotten. Root tests, scripts, docs and safeguards must match their release-template copies. A missing runtime parser is a failure, not a successful syntax check.
