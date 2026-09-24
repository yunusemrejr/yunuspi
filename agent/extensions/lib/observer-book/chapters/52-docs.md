---
id: docs
part: business
title: Documentation and technical writing
summary: Documentation people use: writing for a named reader and task, the four documentation modes, README essentials, runnable examples, accuracy that tracks the code, and comments versus docs.
terms: documentation docs doc readme guide tutorial how-to reference explanation api docs docstring jsdoc comments changelog wiki manual onboarding example examples quickstart install instructions technical writing markdown
files: .md .mdx .rst readme.md docs/
tools: claim_check source_check
skills: github-readme-authoring natural-editorial-writing api-design word-document-authoring presentation-authoring
---

# Documentation and technical writing

Documentation is a product feature: it decides whether people can adopt, operate and contribute to software. Good docs answer the question the reader has right now, in the form suited to that question, and stay true as the code changes.

## Write for a named reader and task {#reader}
<!-- terms: reader audience user task goal beginner expert operator contributor question -->

**Principle.** Before writing, name who will read the page and what they are trying to accomplish; cut everything that does not serve that task.

**Why.** Documentation written "for everyone" mixes installation steps, architecture musings and API details, serving no reader well. A new user needs a quickstart; an operator needs runbooks; a contributor needs architecture and conventions; an integrator needs reference. Naming the reader clarifies scope, assumed knowledge and structure.

**Signals.** Pages mixing tutorials, reference and design rationale; docs assuming knowledge their readers lack.

**Ask.** Who reads this page, and what are they trying to do when they open it?

**Traps.** Writing only for experts because they are the authors.

## Use the right documentation mode {#modes}
<!-- terms: tutorial how-to guide reference explanation diataxis learning task information understanding -->

**Principle.** Separate tutorials (learning by doing), how-to guides (solving a specific task), reference (exact facts) and explanation (why things are the way they are).

**Why.** Each mode serves a different need and fails when mixed: a tutorial interrupted by exhaustive option tables loses learners; a reference page full of narrative is slow to scan. The Diátaxis framework formalizes this. Organizing docs by mode makes gaps obvious (no how-to for a common task) and keeps each page focused.

**Signals.** Tutorials full of caveats and options; reference pages with long narratives; no task-oriented guides.

**Ask.** Is this page a tutorial, how-to, reference or explanation, and does it stay in that mode?

**Traps.** Rigid categorization of small projects that need only a good README.

## The README answers four questions on the first screen {#readme}
<!-- terms: readme what why quickstart install usage status license badge example first screen -->

**Principle.** A README should say on its first screen what the project is, why someone would use it, how to get it running quickly, and its current status.

**Why.** The README is the front door and often the only page read. Visitors decide within seconds. A one-line description, a visual or short example, a copy-paste quickstart and honest status (experimental, stable, maintained) let them decide and start. Details belong further down or in linked docs.

**Signals.** READMEs starting with long badges or history; no quickstart; installation instructions that do not work.

**Ask.** From the first screen of this README, can a visitor tell what it is, why to use it and how to start?

**Traps.** Marketing language that overstates maturity.

## Examples must run {#examples}
<!-- terms: example examples code sample snippet runnable copy paste tested doctest working -->

**Principle.** Every code example should be complete enough to copy and run, and tested so it stays correct.

**Why.** Readers copy examples verbatim. Examples missing imports, using outdated APIs or placeholder values that look real cause frustration and support requests. Testing examples (doctests, example projects in CI, snippet extraction) keeps them in sync with the code. Real, runnable examples teach faster than prose descriptions.

**Signals.** Snippets with ellipses where required code belongs; examples using renamed APIs; no example tests.

**Ask.** Would this example run if pasted into a fresh project today?

**Traps.** Examples so complete they bury the point in boilerplate.

## Docs that lie are worse than none {#accuracy}
<!-- terms: accurate accuracy outdated stale wrong docs drift update sync code change version -->

**Principle.** Update documentation in the same change that alters behavior, and remove docs that can no longer be kept accurate.

**Why.** Readers trust documentation; wrong docs cause confident mistakes and erode trust in all docs. Drift happens when docs live far from code and changes skip them. Keeping docs next to code, reviewing doc changes with code changes, and generating reference docs from source reduce drift. Claims in docs (performance, compatibility, platform support) must be as verifiable as code.

**Signals.** Behavior changes without doc updates; docs describing removed options; unverifiable claims.

**Ask.** Which documentation describes the behavior this change alters, and was it updated?

**Traps.** Over-documenting internals that change constantly.

## Comments, docstrings and docs have different jobs {#comments-vs-docs}
<!-- terms: comments docstrings api documentation inline why how contract parameters returns -->

**Principle.** Inline comments explain non-obvious why; docstrings describe contracts (parameters, returns, errors, side effects); guides explain how to accomplish tasks.

**Why.** Mixing these produces comments that narrate code, docstrings that repeat names, and guides missing entirely. Contract documentation on public functions tells callers what they can rely on, including error behavior and edge cases. Task-level knowledge belongs in guides where readers look for it.

**Signals.** Public APIs without contract docs; comments explaining what code does line by line; knowledge available only in code comments.

**Ask.** Is each piece of knowledge documented where its reader will look for it?

**Traps.** Docstring boilerplate that adds nothing beyond the signature.
