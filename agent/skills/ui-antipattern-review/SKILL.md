---
name: ui-antipattern-review
description: "Detect and repair generic, inaccessible or incoherent UI design using concrete visual evidence."
---

# UI Anti-pattern Review

Use for UI audits, redesign and preventing formulaic “AI-looking” layouts. Judge a design by its purpose and execution, not a universal ban on particular colors or shapes.

## Working method

- Inspect rendered screens with real content and common interaction states.
- Identify hierarchy, contrast, spacing and consistency defects precisely.
- Choose one coherent visual system and remove unjustified decoration.
- Verify keyboard, responsive, empty/error and reduced-motion behavior.

Read [patterns and examples](references/patterns.md) for the relevant implementation mode; do not load unrelated modes. Inspect the actual runtime, project conventions and constraints before choosing syntax, dependencies or deployment steps. User instructions take precedence; this skill adds no authority to change external systems.

## Evidence and completion

Use a small representative case and the relevant failure case to check the result. Report what was executed, what remains unverified, and any material compatibility assumption. Do not invent measured outcomes or treat reading this guide as verification.

## When an edit hook flags a pattern
Read `references/patterns.md`, then inspect the complete component and the existing design rules. A partial CSS edit cannot prove a missing accessibility safeguard. Prioritize broken tasks and readability before decorative refinements. Verify the narrowest repair at a small and a large viewport, including relevant focus, loading, error and motion states. Do not loop through redesigns or replace the project's visual identity to satisfy a heuristic.
