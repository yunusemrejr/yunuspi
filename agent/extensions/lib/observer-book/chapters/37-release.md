---
id: release
part: operations
title: CI/CD, versioning and release
summary: Shipping with confidence: CI as the source of truth, reproducible builds, caching, semantic versioning, changelogs and release notes for humans, tags and provenance, and fixing red builds first.
terms: ci cd continuous integration continuous delivery pipeline workflow github actions gitlab build job step cache artifact release releases version versioning semver changelog release notes tag tags publish npm publish package registry provenance red green failing ci
files: .github/workflows/ .gitlab-ci.yml package.json changelog.md
tools: workflow_probe git_info
skills: github-actions-workflows github-release-notes git-github multi-developer-pipelines
---

# CI/CD, versioning and release

Continuous integration is a promise that main is always releasable. Release engineering makes each release identifiable, reproducible and understandable. Both depend on discipline more than tooling: red builds fixed immediately, versions that mean something, and notes written for the people who upgrade.

## A red main is an emergency {#ci-green}
<!-- terms: ci red failing broken build main branch green fix first flaky rerun | watch: ci-touched -->

**Principle.** When CI on the main branch fails, fixing it takes priority over new work; a pushed commit without a green run is unfinished.

**Why.** A broken main blocks everyone, masks new failures behind existing ones and erodes the meaning of green. Teams that tolerate red builds stop trusting CI, and real regressions slip through. Local tests passing is not the same as CI passing: CI runs clean, on different platforms and with stricter settings. Reruns are for diagnosing flakiness, not for wishing failures away.

**Signals.** Work continuing while CI is red; pushes without checking the resulting run; repeated reruns of failing jobs.

**Ask.** What is the CI status of the last pushed commit, and is anything red being ignored?

**Traps.** Disabling tests to make CI green.

## Builds must be reproducible {#reproducible}
<!-- terms: reproducible lockfile pin versions hermetic cache deterministic toolchain node version ci ci-only -->

**Principle.** Pin toolchain and dependency versions, install from lockfiles with frozen modes, and make CI steps independent of machine state.

**Why.** Builds that pull the latest versions pass today and fail tomorrow without any code change. npm ci, pip with hashes, frozen lockfiles and pinned runtime versions make builds repeatable and failures meaningful. Hermetic steps (no reliance on preinstalled global tools) make CI and local runs agree.

**Signals.** npm install instead of npm ci in pipelines; floating version ranges for critical tools; CI depending on runner-preinstalled software without pinning.

**Ask.** Would this build produce the same result next month from the same commit?

**Traps.** Pinning without a process to update pins.

## Versions communicate compatibility {#semver}
<!-- terms: semver semantic versioning major minor patch breaking change pre-release 0.x version bump -->

**Principle.** Use semantic versioning by intended public behavior: patch for compatible fixes, minor for compatible features, major for breaking changes.

**Why.** Version numbers tell users whether upgrading is safe. Breaking changes in a minor release break automated update policies and trust; inflated majors for trivial changes hide real breakage. Pre-1.0 projects often treat minor as breaking; stating the policy explicitly avoids confusion. Version bumps should be deliberate decisions tied to release notes.

**Signals.** Breaking changes in patch or minor releases; versions bumped without release notes; version metadata out of sync across packages.

**Ask.** Given what changed for users, is this a patch, minor or major release?

**Traps.** Versioning by date or commit count when consumers rely on semver.

## Release notes are for humans {#release-notes}
<!-- terms: release notes changelog upgrade migration guide highlights breaking changes what changed why -->

**Principle.** Write release notes that tell users what changed, why it matters to them, what they must do, and what broke—not a list of commit messages.

**Why.** Commit logs describe implementation; users need impact. Good notes lead with highlights, clearly flag breaking changes and migration steps, credit contributors, and link details. Changelogs kept current with each change are easier than reconstructing history at release time. Notes are also marketing: they show momentum and care.

**Signals.** Release notes copied from commit subjects; breaking changes buried; no upgrade instructions.

**Ask.** Could a user decide whether and how to upgrade from these notes alone?

**Traps.** Overselling changes or claiming unmeasured improvements.

## Tags are immutable identities {#tags}
<!-- terms: tag tags git tag immutable release commit sha provenance signed artifact reproducible identity -->

**Principle.** A release tag points to exactly one tested commit forever; never move or reuse a published tag, and publish artifacts from that tagged commit.

**Why.** Tags are how users, caches and security tooling identify releases. Moving a tag silently changes what a version contains, breaking reproducibility and trust—sometimes indistinguishable from an attack. Build provenance (attestations linking artifacts to source and workflow) lets consumers verify what they install.

**Signals.** Force-pushed or deleted release tags; artifacts built from uncommitted changes; releases published from a different commit than tested.

**Ask.** Does this release's tag point to the exact commit that passed CI, and was it published from there?

**Traps.** Tagging before CI completes on the commit.

## Pipelines should be fast and cached {#fast-ci}
<!-- terms: fast ci cache caching parallel jobs matrix duration minutes queue test sharding -->

**Principle.** Keep CI fast with dependency caches keyed on lockfiles, parallel jobs, test sharding and running expensive checks only where needed.

**Why.** Slow CI encourages batching changes and ignoring results. Caches cut minutes of installs; parallelism and sharding cut test time; path filters skip irrelevant jobs. But caches keyed wrong serve stale dependencies, and skipped checks must not create blind spots for changes that matter.

**Signals.** Every job reinstalling dependencies from scratch; serial jobs that could run in parallel; CI taking tens of minutes for small changes.

**Ask.** Where does CI spend its time, and which parts could be cached or parallelized safely?

**Traps.** Cache poisoning across branches; path filters that skip tests for shared code.
