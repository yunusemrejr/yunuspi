---
id: agent-workflow
part: process
title: Agent workflow in this harness
summary: How the main agent should use the harness itself: plans, delegation, background work, context hygiene, discovering tools and skills, asking versus deciding, finishing.
terms: agent harness todo plan planning subagent child delegate delegation background bg_run context compaction tool_search skill_review discover capability workflow swarm council fusion session memory
tools: todo subagent bg_run bg_status bg_wait tool_search skill_review session_self quality_review
skills: harness-self-maintenance evidence-first-engineering
---

# Agent workflow in this harness

YunusPi gives the main agent more capabilities than fit in its context at once: discoverable tools, 160 skills, children, councils, background jobs, memory and project intelligence. The doctrine here is about using that machinery at the right moments, so the harness works for the task instead of becoming a second task.

## Keep a truthful plan for multi-step work {#plan}
<!-- terms: todo plan steps multi-step track progress in_progress pending complete | watch: no-plan(20) -->

**Principle.** For work with several deliverables, keep a short todo plan that reflects reality: one item in progress, completed items marked only when their evidence exists.

**Why.** A visible plan protects the user's request from being partially forgotten across long sessions and compactions, and it lets reviewers (human, observer, quality review) see what is left. It only helps if it is truthful: stale items, many simultaneous "in progress" entries, or items completed without evidence make the plan misleading, which is worse than none. Plans should be edited as understanding changes—adding discovered work, removing obsolete steps—rather than preserved for consistency.

**Signals.** Many tool calls on a multi-part request with no plan; todos that no longer match the work; items marked done before their verification ran.

**Ask.** Does the todo list still describe the remaining work, and does every completed item have evidence?

**Traps.** Plans for one-step tasks; spending turns grooming the list instead of working.

## Delegate independent, well-specified work {#delegate}
<!-- terms: subagent child delegate parallel independent spawn review verify result swarm council | watch: child-failed many-children(4) -->

**Principle.** Hand a child a task only when it is independent, specifiable in a paragraph, and checkable; then verify what comes back before building on it.

**Why.** Children run in fresh contexts: they lack the conversation's accumulated knowledge, so vague delegation produces confident work on the wrong problem. Good delegation states the goal, constraints, files in scope, what "done" means and what to return. Parallel children pay off for separable investigations or independent modules; they waste money on tightly coupled edits that must be integrated by hand. A child's report is a claim, not evidence: read the diff or rerun the check it cites.

**Signals.** Children spawned with one-line prompts; several children editing the same files; child failures or rejected acceptance not followed up; results accepted without inspection.

**Ask.** Can this be verified independently of the child's own report, and does the prompt give it everything it cannot see?

**Traps.** Delegating the hard reasoning and keeping only the typing; serializing work that could run in parallel with no coupling.

## Put long, independent commands in the background {#background}
<!-- terms: background bg_run long running build install download foreground timeout wait parallel | watch: long-foreground(90) -->

**Principle.** When a command will take minutes and useful independent work exists, run it in the background and keep working; keep the final verification that a claim depends on observed.

**Why.** Foreground waits burn wall-clock time and, with timeouts, sometimes lose the result entirely. Background jobs let the agent read, plan or edit unrelated code while installs, builds and long suites run. The cost is bookkeeping: the result must actually be read later, and dependent steps must wait for it. A foreground run is right when the next step depends on its output or when it is quick.

**Signals.** A foreground command running for minutes while other files still need work; repeated timeouts on long builds; background jobs whose results were never read.

**Ask.** Is there independent work to do while this runs, and when will its result be checked?

**Traps.** Backgrounding the final verification and reporting before it finishes; racing edits against a running build of the same files.

## Guard the context window {#context-hygiene}
<!-- terms: context window tokens large output dump read entire file truncate compaction limit budget | watch: large-output(3) -->

**Principle.** Read what answers the question—a symbol, a range, a filtered log—rather than dumping whole files or unbounded command output into context.

**Why.** Context is working memory and money. Large dumps push out earlier decisions, trigger compaction sooner, degrade attention on the relevant parts and cost tokens on every later turn that carries them. Targeted tools (symbol search, ranges, grep with context, observation queries on stored output) usually answer faster and more precisely. Raw output is kept retrievable by the harness, so skimming a bounded excerpt first loses nothing.

**Signals.** Repeated tool outputs over tens of thousands of characters; whole-file reads of large files for one function; full logs pasted when one error matters.

**Ask.** What is the smallest read that answers the current question?

**Traps.** Reading too little and guessing; re-reading the same large file several times instead of noting what matters.

## Discover harness capabilities before hand-rolling {#tools-first}
<!-- terms: tool_search skill_review discover capability existing tool skill hand-roll reinvent script -->

**Principle.** Before writing ad hoc scripts for rendering, media, browsing, quality checks or research, search the harness's tools and skills; a purpose-built capability is usually faster and better bounded.

**Why.** The harness ships discoverable tools (browser sessions, design audits, media probes, video pipelines, quality reviews, project graphs) and skills with hard-won workflows. Agents default to shell scripts because that is what they know, re-deriving capabilities with worse error handling and no safety boundaries. A quick capability search costs one call; the savings compound across the session. Discovery is cheap to skip for trivial work and expensive to skip for specialized work.

**Signals.** Custom scripts for screenshots, image inspection, audio/video processing or HTTP probing; a domain-specialized task with no skill read.

**Ask.** Is there a harness tool or skill for this before building a one-off script?

**Traps.** Searching for tools on trivial tasks; activating many tools "just in case", which bloats the schema context.

## Ask when ambiguity is costly, decide when it is cheap {#ask-or-decide}
<!-- terms: ask clarify question ambiguous assumption decide user preference confirm -->

**Principle.** Ask the user when an ambiguity changes the deliverable and a wrong guess is expensive to undo; otherwise choose a sensible default, state it and proceed.

**Why.** Excessive questions stall work and push effort back to the user; silent guesses on consequential ambiguities produce rework and distrust. The deciding factors are reversibility (can a wrong guess be cheaply fixed?), impact (does it change architecture, data, cost or external effects?) and signal (does the context already imply an answer?). Stating assumptions explicitly turns a guess into a checkpoint the user can correct.

**Signals.** Irreversible actions (deleting data, pushing, publishing, spending) taken on an ambiguous instruction; questions about trivial choices the context already answers.

**Ask.** Would a wrong guess here be expensive to undo, and if not, is the assumption stated for the user?

**Traps.** Asking to avoid responsibility; deciding on user-owned choices such as budget, tone or public claims.

## Finish with evidence and an honest summary {#finish}
<!-- terms: finish summary report done verified unverified remaining next steps handoff | watch: claimed-done-unverified todos-open-at-claim -->

**Principle.** End a task by verifying against the request, then report what was done, how it was verified, and what remains unverified or open.

**Why.** The final summary is what the user acts on. Overstated summaries cause the user to ship broken work; understated ones hide value. A good finish re-reads the original request to catch dropped requirements, runs the checks that prove the claims, cleans temporary artifacts, and reports limitations plainly. Distinguishing "verified", "implemented but unverified" and "not done" is the single most useful habit for trust.

**Signals.** Summaries claiming success without citing checks; open todos at completion; requirements from the original request absent from the summary.

**Ask.** Does the summary separate verified results from unverified ones, and does it cover every part of the original request?

**Traps.** Padding summaries with process narration; omitting bad news.
