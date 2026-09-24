---
id: git
part: operations
title: Git and code review
summary: Version control as communication: atomic commits with meaningful messages, branch hygiene, safe history rewriting, conflict resolution, reviewable pull requests and constructive review.
terms: git commit commits branch branches merge rebase squash cherry-pick conflict conflicts pull request pr review reviewer diff history log blame bisect stash reset revert force push main master remote origin github gitlab
tools: git_info ast_diff code_quality
skills: git-github github-repo-presentation multi-developer-pipelines
---

# Git and code review

Version control is a communication medium across time: commits explain changes to future readers, including you. Code review is communication across people: it spreads knowledge and catches defects when changes are shaped to be reviewable.

## Commits are atomic and explained {#commits}
<!-- terms: commit message atomic small focused why conventional commits subject body -->

**Principle.** Each commit should contain one logical change that builds and passes tests, with a message explaining what changed and why.

**Why.** Atomic commits make history searchable, reverts safe and bisection precise. Messages are the only place the "why" survives: the diff shows what changed, not the constraint or bug that motivated it. A subject line in the imperative and a body explaining reasoning and tradeoffs serve reviewers now and maintainers later.

**Signals.** Commits mixing unrelated changes; messages like "fix" or "updates"; commits that leave the build broken.

**Ask.** Could this commit be reverted on its own, and does its message explain why the change was needed (git_info review flags risky additions before committing)?

**Traps.** Hundreds of micro-commits that should be squashed; perfectionism delaying commits.

## Never rewrite shared history {#history}
<!-- terms: force push rebase reset amend shared branch history rewrite main protected -->

**Principle.** Rebase, amend and force-push only on branches nobody else has based work on; on shared branches, add commits or merge instead.

**Why.** Rewriting published history breaks collaborators' clones, can silently discard their commits, and destroys the audit trail. Protected branches enforce this for main. On personal branches, rewriting to produce a clean series is good practice; --force-with-lease prevents overwriting others' pushes.

**Signals.** Force pushes to main or shared branches; git reset --hard on branches with others' work; amended published commits.

**Ask.** Has anyone else pulled this branch, and does this command rewrite history they depend on?

**Traps.** Plain --force instead of --force-with-lease.

## Resolve conflicts by understanding both sides {#conflicts}
<!-- terms: merge conflict conflicts resolve ours theirs markers rebase conflict semantic -->

**Principle.** Resolve conflicts by understanding what each side intended and combining the intents, then run tests—never by picking a side blindly.

**Why.** Choosing "ours" or "theirs" wholesale silently discards someone's change. Conflicts often hide semantic conflicts: both sides edited logic in compatible-looking ways that break together. Generated files and lockfiles should be regenerated with their tools rather than hand-merged.

**Signals.** Conflicts resolved by taking one side entirely; lockfiles merged by hand; no test run after resolution.

**Ask.** What did each side of this conflict intend, and does the resolution preserve both?

**Traps.** Leftover conflict markers in code or docs.

## Keep pull requests reviewable {#pull-requests}
<!-- terms: pull request pr small reviewable description context screenshots scope stacked -->

**Principle.** Keep pull requests small and focused, with a description of the problem, the approach, how it was tested and what to look at closely.

**Why.** Review quality drops sharply as diff size grows: large PRs get rubber-stamped. Small PRs are reviewed faster and more carefully. A good description gives reviewers context the diff cannot—why this approach, what alternatives were rejected, what is risky—plus evidence (test output, screenshots for UI).

**Signals.** PRs with thousands of lines of mixed changes; empty descriptions; UI changes without screenshots.

**Ask.** Could a reviewer understand and verify this change in one sitting from its description and diff?

**Traps.** Splitting changes so finely that the whole cannot be understood.

## Review for correctness first, style last {#review}
<!-- terms: code review reviewer comments feedback nit blocking correctness design tests readability -->

**Principle.** Review in priority order—correctness and security, design, tests, readability, style—and label comments by severity.

**Why.** Reviews that focus on formatting miss bugs; linters should handle style. Explicitly marking comments as blocking or optional helps authors prioritize and keeps review collaborative. Asking questions ("what happens if…?") often works better than prescribing fixes. Reviewers should also check what is not in the diff: missing tests, missing migrations, callers not updated.

**Signals.** Reviews consisting of style nits; no comments on tests or edge cases; unlabeled comments mixing trivia with blockers.

**Ask.** What could break in production because of this change, and is it tested?

**Traps.** Approving without reading; blocking on personal preferences.

## Use history as a debugging tool {#history-tools}
<!-- terms: git log blame bisect show diff history regression when why changed pickaxe -->

**Principle.** Use blame, log with pickaxe search, show and bisect to learn when and why code changed before changing it again.

**Why.** Strange code often has a reason recorded in history: a bug fix, a workaround for a platform issue, a reverted attempt. git log -S finds when a string appeared or disappeared; blame links lines to commits and their messages; bisect finds regressions mechanically. Skipping this repeats past mistakes.

**Signals.** Reverting or "cleaning up" unusual code without checking why it exists; regressions investigated without history.

**Ask.** What does the history say about why this code looks the way it does (git_info blame summarizes a line range)?

**Traps.** Blaming people instead of understanding changes.
