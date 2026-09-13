---
name: github-release-notes
description: Cut a release and write its notes — semantic-version decisions, Keep-a-Changelog entries, GitHub Release bodies, prereleases, breaking-change and migration sections. Use for changelogs, release notes, version bumps and tag/release preparation; not for routine commit messages or git history recovery.
---

# Release notes and changelogs

Release notes are written for the people who must decide whether to upgrade. Derive them from what actually merged, not from memory, and state impact before implementation detail.

## Establish the source of truth

Collect the change set before writing a word:

```bash
git log --oneline v1.4.1..HEAD          # what landed since the last tag
git diff --stat v1.4.1..HEAD            # where the risk is
gh pr list --state merged --search "merged:>=2026-08-01"
```

Read the linked issues for user-visible behavior; a commit title alone often hides a compatibility change. If a change cannot be traced to a merge or commit, do not describe it as released.

## Decide the version deliberately

| Change | Bump |
| --- | --- |
| Removed/renamed public API, changed default behavior, raised minimum runtime, changed output format | major |
| New compatible feature, new flag or endpoint, deprecation warning | minor |
| Bug fix, performance fix, dependency patch, docs-only | patch |
| Security fix for a supported line | patch on each supported line, plus an advisory |

For `0.x` releases, state breaking changes explicitly in the notes even though the version number does not signal them. A deprecation is a minor release that names the removal version and the replacement.

## Write the notes

Order sections by reader interest: `Upgrade`/breaking changes first, then `Added`, `Changed`, `Fixed`, `Removed`, `Deprecated`, `Security`. For each entry say what changed in behavior and who is affected; link the PR or issue. Keep internal refactors out unless they change behavior or performance measurably.

An upgrade section earns its place when it contains the before/after the reader needs:

```markdown
### Upgrade from 1.3
`client.run()` no longer retries by default. Pass `retries: 3` to keep the old
behavior:
    const result = await client.run({ retries: 3 });   // was implicit
```

When there is genuinely nothing user-visible, say so in one line ("internal changes only; no action required") instead of padding the notes.

## Changelog file

Maintain `CHANGELOG.md` as work merges, not at release time, so the release is an edit rather than an archaeology project:

- `## [Unreleased]` at the top, then one `## [x.y.z] - YYYY-MM-DD` section per release (Keep a Changelog categories, newest first).
- Link versions to compare views and issues/PRs to their URLs where the repository supports it.
- Do not backfill history you cannot verify, and do not rewrite entries for released versions; correct them with a follow-up note if they were wrong.

## GitHub Releases

- Tag the exact commit you intend to ship (`git rev-parse v1.4.2^{commit}`) and prefer annotated tags; publishing a release creates a tag if one does not exist.
- Auto-generated notes are a starting point, not the deliverable. Configure `.github/release.yml` categories so the generated body arrives grouped, then edit for user impact, migration steps and attribution.
- Use `--prerelease` for `-rc.N`/`-beta.N` builds and mark "latest" deliberately; a prerelease should never be the repository's default download without a reason.
- Attach built artifacts, checksums and provenance where the project distributes binaries; state the supported window when ending a version line.
- Editing a published release is fine for typos; changing what users were told shipped is not — add a correction note instead of silently rewriting.

Read [changelog and release note patterns](references/changelog-and-notes.md) for the Keep-a-Changelog skeleton, `.github/release.yml` categories, migration-note patterns and a before/after example.
