---
name: operate
description: "Linux operations, office files, growth/finance and harness maintenance."
---

# Operate — Linux, office, growth, harness

- Read state before changing it; prefer reversible steps; back up before destructive operations.
- Office files: preserve formatting, work on copies, verify by reopening the result.
- Harness changes: patch durable source, install through the supported path, validate, note restart needs.
- Growth/finance: dated figures, explicit units, no invented metrics.

For decision-model or routing work, open the [route comparison note](examples/route-comparison.md) for a paired evaluation and a runnable cost example. Compare complete tasks, including escalation and retry costs.

For an external write, name the exact target, operation and reason in the scoped approval. If the host cannot prompt, ask the user in chat and continue work within scope while waiting.

## Further checklists

For a full audit, a schema plan or programmatic pages, the open playbooks in `../copywriting/references/marketing-playbooks.md` (`seo-audit`, `ai-seo`, `schema`, `programmatic-seo`, `site-architecture`) list checks worth comparing against this file.

## YunusPi self-maintenance

- The live install under `~/.pi` is not edited directly. The source is a clone of the yunuspi repository (find it with `git worktree list` from any clone; its root holds `scripts/install.mjs`).
- Edit and test in the source checkout. Run one test file at a time, capped: `systemd-run --user --scope --quiet -p MemoryMax=3G -p MemorySwapMax=0 timeout -s KILL 300 node scripts/test.mjs tests/<name>.test.mjs`. Never the full suite.
- Commit and push `main`. No tags, releases or CI waits: the push is the publication.
- Deploy from a session launched in `~/.pi`, or the user runs it: `~/.pi/agent/bin/yunuspi update --source <checkout>`. A session launched in the checkout cannot write the install.
- Verify the install with `node ~/.pi/agent/scripts/verify-harness.mjs`.
