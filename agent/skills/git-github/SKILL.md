---
name: git-github
description: "Git and GitHub end to end: history recovery, rebase and force-push rules, gh CLI and CI triage, GitHub Actions hardening, READMEs, repo health files, changelogs and release notes, and multi-developer branching, promotion and rollback."
---

# Git and GitHub

## Recovery and history
- Lost commits: `git reflog`, then `git branch recovery <sha>`. Orphaned objects: `git fsck --lost-found`.
- Find causes with `git log -S'str'` (pickaxe), `-G regex`, `--follow`, `git blame -L`; `git bisect run ./check.sh` (exit 1 = bad).
- `git diff A...B` shows what B added since the merge-base. After merging main into a feature branch, `git rebase --onto main <merge-sha> feature`, then confirm `git log main..feature` lists only your commits.
- Rebase only unpublished commits (`commit --fixup=<sha>`, `rebase -i --autosquash`). `--abort` is always safe; confirm with `git cherry` before `--skip`.
- Push with `--force-with-lease`, never `--force`; never force a protected branch.
- Conflicts: read both sides' intent (`git diff --diff3`). Silently deleting one side is the classic corruption.
- Prefer a WIP commit or `git worktree` to `git stash`. Dry-run `git clean -fdn`; test ignore rules with `git check-ignore -v`.

## Review and merge
- One merge strategy per repo (squash, rebase or merge); mixing them confuses bisect and revert.
- Protect the default branch: required review and passing checks. CODEOWNERS routes reviews; an ownerless rule breaks.
- Review behavior and invariants, inline. REQUEST CHANGES only for blockers.

## gh CLI and CI triage
- `gh pr create --fill`, `gh pr checks --watch`, `gh pr merge --rebase --auto`, `gh run view <id> --log-failed`. Read the first real error in the failed step, not the first warning.
- Never mask a gate with `continue-on-error` or `|| true`; retry flaky network steps with bounded backoff.
- Required-check names must match job names. A renamed or `if:`-skipped job leaves its required check pending forever.

## GitHub Actions hardening
- Top-level `permissions: contents: read`; write scopes per job. Pin third-party actions to commit SHAs, version in a comment.
- Never combine `pull_request_target` with an untrusted checkout. Route `github.event.*` through `env:`, never `run:` interpolation.
- Fork PRs get no secrets; gate deploys with environment reviewers. Prefer OIDC scoped to repo, branch and environment. Self-hosted runners never run untrusted PRs.
- Set `timeout-minutes`; `concurrency` with `cancel-in-progress` for PRs only, never releases; cache on the lockfile hash.

## READMEs and repo health
- A README says what the project is, who it is for and how to start, within the first screen. Run every documented command from a clean checkout. No secrets or private hostnames.
- At most five badges, each live (CI, release, license). Never hardcode coverage. Images need alt text.
- Health files: one-line description and 5-10 topics; full LICENSE text; CONTRIBUTING with commands that work; SECURITY with supported versions and a private reporting channel; a monitored contact in CODE_OF_CONDUCT; PR template asking for verification evidence; CODEOWNERS paths that exist.
- Check from outside: logged out, then a fresh clone following CONTRIBUTING.

## Changelogs and releases
- Derive notes from merges since the last tag (`git log --oneline vX..HEAD`, `gh pr list --state merged`), not memory.
- Version by the most severe change: removed or changed public behavior is major; a compatible capability is minor. In 0.x, state breaking changes explicitly.
- Lead with upgrade steps and breaking changes, with before/after code; link PRs.
- Keep `## [Unreleased]`; never rewrite shipped sections. Tag the exact shipped commit and attach checksums or provenance. Correct a published release openly.

## Multi-developer flow
- Map branches, environments, gates and promoters before changing anything. Keep main releasable with short-lived branches; write down branch lifetimes and merge direction.
- Build once; promote the same artifact digest with its config revision. Secrets never live in manifests, chat or CI logs.
- Separate deploy from release. Release flags get an owner and removal date; kill switches and entitlements follow different rules.
- Every promotion names its rollback (previous digest, flag flip, traffic shift). Migrations must be backward-compatible or have a forward fix. Practice rollback on staging.
- Hotfixes use the same pipeline at higher priority: branch from the release tag, second reviewer, forward-merge to main. Pre-agree when to roll back instead of fixing forward.
- Track lead time, change-failure rate and time to restore. Quarantine flaky checks with an owner and expiry.
