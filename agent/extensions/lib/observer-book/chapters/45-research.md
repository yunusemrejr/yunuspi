---
id: research
part: science
title: Research methodology
summary: Finding out what is true: primary sources over summaries, dating and triangulating claims, separating facts from inferences, search strategy, timeboxing exploration, and synthesis into recommendations.
terms: research investigate investigation search sources source citation cite reference documentation docs paper papers article web browse evidence claim fact verify compare comparison alternatives survey literature review report
tools: web_search web_research fetch_content get_search_content research_toolkit claim_check
skills: research scientific-paper-research evidence-first-engineering financial-statement-analysis
---

# Research methodology

Research is the disciplined reduction of uncertainty. Agents research constantly—library APIs, error messages, best practices, market facts—and the quality of everything downstream depends on whether what was found is true, current and relevant.

## Prefer primary sources {#primary-sources}
<!-- terms: primary source official documentation spec specification changelog source code original paper -->

**Principle.** Go to the source of truth—official documentation, specifications, source code, original papers, the vendor's changelog—before summaries, blog posts or forum answers.

**Why.** Secondary sources compress, simplify and date quickly; forum answers may apply to other versions; AI-generated summaries can be confidently wrong. Primary sources are authoritative and include the edge cases. For code libraries, the installed version's source and types are the ultimate reference.

**Signals.** Decisions based on blog posts or old forum answers; API usage copied without checking the documentation for the installed version.

**Ask.** What does the primary source say, for the version actually in use?

**Traps.** Primary sources that are themselves outdated or aspirational.

## Date every claim {#currency}
<!-- terms: date current latest version outdated deprecated recent year release changed -->

**Principle.** Check when a source was written and which version it describes; technical facts expire.

**Why.** APIs change, defaults change, best practices change, prices change. Advice from three years ago may be wrong today, and training data of models lags reality. Checking dates and versions—and preferring recent authoritative sources—prevents implementing deprecated patterns.

**Signals.** Undated sources; advice for older major versions applied to current ones; pricing or limits quoted without dates.

**Ask.** When was this source written, and does it describe the version in use now?

**Traps.** Assuming newest is always most correct.

## Triangulate important claims {#triangulate}
<!-- terms: triangulate corroborate multiple sources independent confirm contradict conflicting -->

**Principle.** Confirm important claims with independent sources or direct tests, and investigate contradictions rather than picking the convenient answer.

**Why.** A single source can be wrong, biased or misunderstood. Independent agreement raises confidence; disagreement signals complexity worth understanding (different versions, contexts or definitions). For technical claims, a small experiment is often the fastest independent source.

**Signals.** Critical decisions resting on one source; contradictory sources resolved by preference.

**Ask.** Do independent sources or a direct test confirm this claim?

**Traps.** Counting copies of the same original as independent sources.

## Separate facts, inferences and speculation {#claims}
<!-- terms: fact inference speculation assumption opinion evidence confidence certain uncertain -->

**Principle.** Label findings by epistemic status: verified facts, reasonable inferences, and speculation or opinion.

**Why.** Reports that blend verified facts with guesses in the same confident tone mislead readers into treating guesses as facts. Explicit labels ("the docs state…", "this suggests…", "I could not verify…") let readers weigh each claim appropriately and focus verification where it matters.

**Signals.** Research summaries without sources; inferences stated as facts; no mention of what could not be verified.

**Ask.** Which statements in this summary are verified, which inferred, and which unverified?

**Traps.** Over-hedging every statement until the report says nothing.

## Search strategically {#search-strategy}
<!-- terms: search query keywords exact error message site filetype operators refine iterate -->

**Principle.** Search with exact error messages, precise terms and scoped queries; refine based on what the first results reveal.

**Why.** Good queries find answers in one step: exact error strings in quotes, library names with versions, site-scoped searches of official docs or issue trackers. Vague queries return generic content. Reading the vocabulary used by relevant results improves the next query. Issue trackers and release notes are often where the real answer to a bug lives.

**Signals.** Generic queries repeated with minor variations; exact error messages never searched; issue trackers ignored.

**Ask.** What precise query—exact error text, version, official site—would find the authoritative answer?

**Traps.** Endless searching when a quick experiment would answer faster.

## Timebox exploration, then converge {#timebox}
<!-- terms: timebox time limit explore converge decide recommendation rabbit hole scope enough | watch: reads-no-edits(15) -->

**Principle.** Set a budget for exploration, and when it runs out, converge on a recommendation with the evidence gathered and the remaining uncertainty stated.

**Why.** Research can expand indefinitely; each answer opens new questions. Most decisions need enough evidence, not complete evidence. Timeboxing forces prioritization of the questions that could change the decision. A clear recommendation with stated confidence and open questions is more useful than an exhaustive survey without a conclusion.

**Signals.** Long research phases without intermediate conclusions; surveys of options with no recommendation.

**Ask.** What decision does this research serve, and is there already enough evidence to make it?

**Traps.** Converging prematurely on high-stakes, irreversible decisions.

## Synthesize, do not dump {#synthesis}
<!-- terms: synthesis summary report comparison table recommendation tradeoffs findings structure -->

**Principle.** Present research as a synthesis—answer first, comparison of options against criteria, evidence with sources, recommendation—rather than a pile of findings.

**Why.** Raw findings force the reader to do the synthesis, and they usually lack the context the researcher gathered. Structured comparisons against explicit criteria make tradeoffs visible; sources make claims checkable; a recommendation makes the work actionable. The synthesis is where research creates value.

**Signals.** Reports listing sources and quotes without conclusions; comparisons without criteria.

**Ask.** What is the answer, how do the options compare on the criteria that matter, and what do you recommend?

**Traps.** Synthesis that hides disagreement among sources.
