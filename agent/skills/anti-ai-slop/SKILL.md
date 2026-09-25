---
name: anti-ai-slop
description: Review code, prose, UI and analytical artifacts for empty polish, unsupported claims, unnecessary structure and missing behavior. Use for anti-slop requests or a focused final quality review; preserve intentional style and user scope.
---

# Substance Before Polish

Improve the artifact, not its perceived authorship. No heuristic can prove that work was made by AI. Use one focused pass, fix supported problems, and stop when the requested behavior is verified.

## Working method
1. Identify the audience, task and acceptance criteria. Read the nearest relevant implementation or design guidance.
2. Inspect the artifact itself. Separate observed defects, uncertain concerns and stylistic preferences.
3. Choose the smallest repair that improves usefulness. Preserve established conventions, deliberate creative choices and required wording.
4. Verify the changed behavior. Report remaining unknowns without claiming tests or visual inspection that did not happen.

## Focused checks
Read `references/patterns.md` for code and evidence review. For prose, use `../natural-editorial-writing/SKILL.md`. Check real failure behavior and claim provenance before polishing presentation.

## Interfaces
Read `../ui-antipattern-review/SKILL.md` when UI is central. For website work, apply the 200-rule checklist in `docs/ANTI-SLOP-CHECKLIST.md` (core principle, decision test, final rule) and the observer-book `anti-slop` passages. Inspect real content and interaction states. A screenshot demonstrates appearance, not keyboard behavior. When visual tooling is unavailable, use DOM, geometry and contrast evidence and explicitly limit the conclusion.

## Final check
Does the artifact solve the requested problem? Are claims supported? Are boundaries and failure behavior coherent? Did verification exercise the actual change? Optimize for contextual necessity, not visible completeness: every section, claim, widget and page must earn its place for this reader — apparent sophistication without necessity is the underlying failure mode (see the website necessity catalog in `references/patterns.md`). Avoid broad rewrites solely to satisfy a style heuristic.

Use available `artifact_check` with `operation:"ui"` for component source cues, then verify rendered and interaction states. For code, `code_quality` finds copies (`duplicates`, add `changed:true` for a branch), placeholders, leftovers and dead code (`slop`) and complexity hotspots; for prose, `code_quality` `prose` lists stock phrases with plain replacements and readability numbers. Findings are leads to inspect, not verdicts. See `references/patterns.md` for shared review evidence and code/prose checks.
