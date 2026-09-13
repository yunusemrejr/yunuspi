---
name: github-repo-presentation
description: Prepare a repository's public front door — description and topics, license, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, issue and PR templates, CODEOWNERS, social preview and Pages. Use when opening a repo to outside users or contributors, or auditing its first-run experience; not for code changes or README prose alone.
---

# GitHub repository presentation

A repository's public surface is a set of small files and settings that decide whether a stranger can evaluate, run and contribute to it. Set them up deliberately; an empty `CONTRIBUTING.md` link or a security policy with no reporting channel is worse than none, because it promises process that does not exist.

## Metadata and first impression

- **Description**: one line, what it is + who it is for. It appears in search results, the organization page and social cards.
- **Topics**: 5–10 real, searchable terms (language, domain, framework). No invented or aspirational tags.
- **Social preview**: 1280×640 PNG with the project name legible when scaled to a small card; upload it in repository settings rather than relying on the auto-generated card.
- **Homepage**: set it when a site or docs page exists; keep it current.
- **Default branch**: name it consistently with the ecosystem (`main` unless the ecosystem enforces otherwise), and keep the repository's "About" sidebar accurate (releases, packages, deployments).

## Licensing

- Choose a license deliberately with the copyright holder; never invent a holder or a year, and never copy a license with another project's name in it.
- Ship the full text as `LICENSE` (GitHub detects it and shows the badge). Use SPDX identifiers in package manifests where the ecosystem supports them.
- Vendored or third-party code needs its own notices (`THIRD_PARTY_NOTICES.md`) and license files; do not relicense someone else's code by omission.
- If the project is not open source, say so explicitly instead of leaving the license absent and ambiguous.

## Community health files

Place them in `.github/` (or the repository root) so GitHub surfaces them in the UI:

- `CONTRIBUTING.md`: the actual build, test and lint commands; how to propose a change; what reviewers look for; how long review usually takes. If contributions are not accepted, say that instead.
- `CODE_OF_CONDUCT.md`: adopt a standard text and name a real, monitored enforcement contact — a private channel, not a public issue.
- `SECURITY.md`: supported versions, the private reporting channel (GitHub security advisories or an address), what to include in a report, and the expected acknowledgment window.
- `SUPPORT.md`: where to ask questions (discussions, issues, chat) and what is out of scope.
- `CITATION.cff`: for research or academic software, so the correct citation is machine-readable.
- `FUNDING.yml`: only if there is a real funding destination.

## Templates that reduce noise

- Bug report template: version/commit, environment, exact reproduction steps, expected vs actual, logs. Add a config that routes questions to discussions and security reports to the policy.
- Feature request template: the problem, not just the proposed solution.
- PR template: what changed, why, how it was verified, and any migration or breaking-change note.
- `CODEOWNERS`: per-path owners with real teams or accounts who will be asked to review. Verify every pattern matches paths that exist; a stale pattern is worse than none.

## Settings that must match the files

- Branch protection or rulesets on the default branch: require a pull request, at least one review, and the status checks whose job names actually exist. Renaming a CI job silently un-requires it.
- Enable "automatically delete head branches", Dependabot security updates and (where available) private vulnerability reporting.
- Keep Actions permissions least-privilege and restrict which actions may run; see the GitHub Actions workflow skill for the pipeline side.
- If GitHub Pages is the delivery target, set the source branch/folder and confirm the published URL serves the current build.
- Archive or mark deprecated repositories instead of leaving them half-maintained with open issues.

## Verify from the outside

- Open the repository in a logged-out/private window and confirm the About panel, description, topics, pinned items and social card render correctly.
- Open "New issue" and "New pull request" and confirm the templates appear and links inside them resolve.
- Confirm the license is detected (the sidebar shows the license name) and that the security tab exposes the reporting path.
- Follow `CONTRIBUTING.md` yourself in a fresh clone; if a step fails, the contributor experience is broken.

Read [community health file skeletons](references/health-files.md) for per-file starting points, common mistakes and a settings checklist.
