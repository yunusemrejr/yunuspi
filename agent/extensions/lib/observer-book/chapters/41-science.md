---
id: science
part: science
title: Scientific reasoning
summary: Thinking like a scientist while building: falsifiable hypotheses, controls and baselines, measurement error, reproducibility, confounders and causality, first-principles reasoning, and updating beliefs with evidence.
terms: science scientific hypothesis experiment experiments control baseline measurement measure error uncertainty reproduce reproducibility replicate confounder causal causality correlation first principles evidence bayesian update physics chemistry biology simulation model theory
tools: sandbox_run math_check claim_check
skills: scientific-paper-research statistical-experiments physics-modeling simulation-engineering evidence-first-engineering
---

# Scientific reasoning

The scientific method is the best available technology for not fooling yourself. Software engineering constantly asks empirical questions—is it faster, is it fixed, do users prefer it—and answers them better when the discipline of science is applied.

## Hypotheses must be falsifiable {#falsifiable}
<!-- terms: hypothesis falsifiable prediction test experiment claim evidence wrong -->

**Principle.** State claims so that some observation could prove them wrong, and name that observation before looking.

**Why.** Unfalsifiable claims ("the new design feels better", "this should improve performance") cannot be tested and therefore cannot be trusted. A falsifiable version ("median load time drops at least 20% on the benchmark") specifies what would count as failure. Committing to the test before seeing the data prevents rationalizing any outcome as success.

**Signals.** Claims of improvement with no stated criteria; success criteria chosen after results arrive.

**Ask.** What result would show this claim is wrong, and was it defined before measuring?

**Traps.** Overly narrow criteria that miss real but different improvements.

## Compare against a control {#controls}
<!-- terms: control baseline comparison before after a/b placebo same conditions variable -->

**Principle.** Measure changes against a baseline under the same conditions, changing one variable at a time.

**Why.** Without a control, any change coincides with countless others: time of day, cache state, traffic mix, machine load. Before-and-after comparisons on different days or machines attribute noise to the change. Running baseline and treatment in the same conditions—interleaved, randomized or simultaneous—isolates the effect.

**Signals.** Performance or quality claims from measurements taken at different times or on different machines; several changes evaluated together.

**Ask.** What is this being compared against, and were both measured under the same conditions?

**Traps.** Baselines that were themselves measured badly.

## Every measurement has error {#measurement}
<!-- terms: measurement error uncertainty noise variance precision accuracy repeated trials confidence interval -->

**Principle.** Report measurements with their uncertainty—repeated trials, spread, confidence intervals—and distinguish precision from accuracy.

**Why.** A single measurement cannot distinguish a real effect from noise. Repeating trials reveals variance; the effect must exceed it to be believable. Precision (consistency) differs from accuracy (closeness to truth): a biased instrument can be precise and wrong. Recognizing the resolution of instruments and the noise floor of systems prevents chasing phantom effects.

**Signals.** Single-run comparisons; differences smaller than run-to-run variation claimed as improvements.

**Ask.** How large is the noise compared to the effect being claimed?

**Traps.** Averaging away meaningful bimodal behavior.

## Reproducibility is the standard of proof {#reproducibility}
<!-- terms: reproducible reproduce replicate seed version environment record notebook script -->

**Principle.** A result counts when it can be reproduced from recorded code, data, parameters, seeds and environment.

**Why.** Unreproducible results cannot be verified, debugged or built upon. Recording exact inputs—commit, data version, configuration, random seed, library versions—turns a one-time observation into evidence. Scripts beat manual steps because they document themselves. When a result cannot be reproduced, that fact is itself important information.

**Signals.** Results produced through unrecorded manual steps; experiments without seeds or versions; notebooks run out of order.

**Ask.** Could someone reproduce this result exactly from what is recorded?

**Traps.** Reproducibility theater: recording everything except the one parameter that mattered.

## Correlation is not causation {#causation}
<!-- terms: correlation causation confounder confounding selection bias reverse causality simpson paradox randomize -->

**Principle.** Before concluding that X causes Y, rule out confounders, reverse causation, selection effects and chance—or randomize.

**Why.** Users of a feature may retain better because engaged users adopt more features, not because the feature causes retention. Simpson's paradox can reverse a trend when data is split by a confounder. Randomized experiments break confounding; without them, causal claims need careful design (natural experiments, controls for known confounders) and humility.

**Signals.** Causal language ("X increased Y") from observational data; comparisons between self-selected groups.

**Ask.** What else could explain this relationship, and was the assignment random?

**Traps.** Dismissing all observational evidence; overfitting causal stories to noise.

## Reason from first principles when analogies fail {#first-principles}
<!-- terms: first principles fundamentals physics constraints limits reason derive assumption analogy -->

**Principle.** When conventional approaches seem stuck, break the problem down to fundamental constraints—physics, math, costs—and rebuild the solution from them.

**Why.** Reasoning by analogy ("everyone does it this way") inherits others' assumptions and limits. First-principles reasoning asks what is actually required: the theoretical minimum latency given distance, the real cost of materials, the bytes truly needed. It reveals when a limitation is historical rather than fundamental, and when a proposed solution violates a hard constraint.

**Signals.** Designs justified only by convention; performance targets set without knowing theoretical limits.

**Ask.** What are the fundamental constraints here, and how close is the proposed approach to them?

**Traps.** Ignoring accumulated practical wisdom that encodes real constraints.

## Update beliefs in proportion to evidence {#bayesian}
<!-- terms: update belief evidence prior posterior confidence surprise strong weak evidence calibration -->

**Principle.** Hold beliefs with explicit confidence, update them by how surprising the evidence would be under each alternative, and seek evidence that could change your mind.

**Why.** Confirmation bias makes people seek and overweight supporting evidence. Bayesian thinking asks how much more likely the evidence is if the hypothesis is true than if it is false: weak evidence moves beliefs a little, strong evidence a lot. Calibrated confidence—being right about as often as you claim—builds trust in reports and decisions.

**Signals.** Conclusions unchanged despite contrary evidence; confidence stated as certainty; only confirming tests run.

**Ask.** What evidence would change this conclusion, and has it been looked for?

**Traps.** Endless doubt that prevents any decision.
