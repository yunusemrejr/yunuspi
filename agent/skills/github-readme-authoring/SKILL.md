---
name: github-readme-authoring
description: Write or overhaul a GitHub README — project front pages, profile READMEs and monorepo landing pages — with real positioning, verified quickstarts, honest badges and screenshots. Use for README creation, rewrites and front-page polish; not for git operations, docs-site builds or general prose editing.
---

# GitHub README authoring

A README is a front page, not a manual. A stranger decides in about thirty seconds whether the project is for them: what it is, why it exists, and how to reach a first result. Optimize that decision before adding anything else.

## Before writing

- Read what proves what the project does: package manifest (name, description, bin/scripts, engines), the real `--help` output, the exported API surface, tests and CI config. Describe the code that exists, never the roadmap.
- Identify the reader: an evaluator deciding to adopt it, a contributor setting up a dev environment, or an operator deploying it. One README serves all three only as a front page that links to deeper docs.
- Preserve the author's voice and the existing structure. Do not replace a working README wholesale for style reasons; edit what is wrong or missing.

## Structure that survives scanning

H1 is the project name. Directly below it, one sentence naming what the project is and who it is for; a second sentence only when the value is not obvious. Then include only what applies, ordered by usefulness:

- A real screenshot, GIF or short demo for anything visual; a terminal transcript for CLIs.
- `Install` — the exact command(s), using the registry the project actually publishes to.
- `Quickstart` — the smallest example that produces a visible result, copy-pasteable as written, with the expected output.
- `Usage`/`Configuration` — a table (`option | type | default | description`) once there are more than a few options; otherwise one short code block.
- `Why this exists` / `How it compares` — only with verifiable facts; never invented benchmarks.
- `Status` / `Limitations` — state plainly when the project is early, experimental or has known gaps.
- `Contributing`, `License`, `Acknowledgements` — link, do not inline their contents.

Anything longer than roughly two screens belongs in `docs/`, linked from the README. Keep a table of contents only when there are more than four sections.

## Honesty and verification

- Run every command in the README from a clean checkout before publishing. If a step needs a secret, a specific OS or a paid service, say so in the same block.
- Quote versions that exist (`node >= 22`, `v1.4.x`); do not state minimum versions you have not tested.
- Never place real tokens, keys, internal hostnames, personal addresses or private URLs in examples — use placeholders and environment variables.
- Do not list a feature, integration, badge or compatibility claim you cannot point at in the code or CI.
- Verify that links and relative image paths resolve on GitHub, and on the package registry page when the registry renders the README. A 404 badge or a broken image is the most visible defect a README can have.

## Badges

Badges are evidence, not decoration. Use at most three to five, each reflecting state that actually updates: CI status, latest release, license, supported runtime, package downloads. Prefer static shields for facts that cannot change and dynamic ones for facts that can. Delete badges that need manual updating or point at nothing.

## Visual polish

- Screenshots: capture the real interface at a readable width (roughly 900–1400 px), crop to the content, keep text legible at GitHub's rendered width, and stay consistent with the project's light/dark presentation elsewhere.
- Animated demos: GIF under about 5 MB, or a linked MP4/WebM. Loop one short interaction instead of a full tour.
- Store assets in `docs/assets/` or `.github/assets/` with descriptive lowercase names and always set alt text describing the content ("Settings panel showing the export queue"), not the filename.
- Keep heading levels, code fences and table formatting consistent; ragged spacing is what makes a README read as machine-generated.

## Profile, monorepo and fork READMEs

- Profile README (`github.com/<user>`): short factual introduction, what you work on, links out. Pinned repositories carry the detail; do not front-load awards or vanity metrics.
- Monorepo: a table of packages/apps with path, purpose and status, each linking to its own README, plus how to run one package in isolation.
- Forks and templates: add a short "what this is" line at the top so readers do not mistake it for upstream.

Read [README patterns](references/readme-patterns.md) for skeletons by project type, a badge/asset reference table, weak-to-strong opening rewrites and a final review checklist.
