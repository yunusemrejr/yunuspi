---
id: statistics
part: science
title: Statistics and data analysis
summary: Analysis that survives scrutiny: precise questions and metrics, inspecting raw data, distributions over averages, uncertainty and effect sizes, multiple comparisons, experiment design and honest reporting.
terms: statistics statistical analysis analyze analytics data dataset pandas numpy dataframe mean median percentile distribution variance standard deviation confidence interval p-value significance hypothesis test regression correlation sample size power ab test experiment outlier cohort
files: .ipynb .csv .parquet .xlsx .r
tools: sandbox_run math_check
skills: statistical-experiments data-viz classical-ml-modeling model-evaluation spreadsheet-authoring
---

# Statistics and data analysis

Data analysis converts messy records into claims. Each step—defining the metric, cleaning, aggregating, testing, charting—can introduce errors that produce confident wrong answers. Good analysis is skeptical of its own results.

## Define the question and the metric precisely {#question}
<!-- terms: question metric definition kpi numerator denominator population window cohort precise -->

**Principle.** Before analyzing, write down the exact question, the metric's numerator and denominator, the population and the time window.

**Why.** Vague questions ("are users engaged?") allow any answer. Metric definitions hide decisions that change results: active by which action, in which window, excluding which accounts, deduplicated how. Writing them down makes the analysis reproducible and exposes disagreements early.

**Signals.** Metrics named without definitions; results that change between reports for unclear reasons.

**Ask.** What exactly are the numerator, denominator, population and window of this metric?

**Traps.** Choosing definitions after seeing which one gives the preferred answer.

## Look at the raw data first {#raw-data}
<!-- terms: raw data inspect sample rows missing null duplicate outlier unit encoding schema clean cleaning -->

**Principle.** Inspect samples of raw rows, missing values, duplicates, ranges and units before computing aggregates.

**Why.** Aggregates hide data problems: test accounts, duplicated events, timezone shifts, sentinel values like -1 or 9999, mixed units, truncated imports. A few minutes looking at raw rows and summary statistics prevents hours of analysis on corrupted inputs. Document every cleaning decision because each changes results.

**Signals.** Aggregations computed immediately after loading; no counts of missing or duplicate rows; outliers unexplained.

**Ask.** What do the raw rows, null counts and value ranges look like before aggregation?

**Traps.** Silently dropping rows that do not fit expectations.

## Distributions beat averages {#distributions}
<!-- terms: distribution mean median percentile skew long tail histogram outlier bimodal average -->

**Principle.** Examine distributions and report medians and percentiles alongside means, especially for skewed data like revenue, latency and session length.

**Why.** Means are dragged by outliers: one whale customer can double average revenue; a few stuck requests inflate mean latency. Bimodal distributions (two user types) produce averages that describe nobody. Histograms and percentiles show what typical and extreme cases look like.

**Signals.** Only means reported; skewed metrics summarized by averages; no distribution plots.

**Ask.** What does the distribution look like, and does the average describe a typical case?

**Traps.** Removing outliers that are the most important part of the story.

## Report uncertainty and effect size {#uncertainty}
<!-- terms: confidence interval uncertainty effect size significance p-value practical significance sample size error bars -->

**Principle.** Report effect sizes with confidence intervals, not just p-values, and distinguish statistical significance from practical importance.

**Why.** A p-value says how surprising the data would be if there were no effect; it says nothing about how large or important the effect is. Large samples make trivial differences "significant"; small samples leave important ones uncertain. Confidence intervals show both magnitude and uncertainty, supporting real decisions.

**Signals.** Results reported as "significant" without magnitude; point estimates without intervals; decisions from tiny samples.

**Ask.** How large is the effect, how uncertain is it, and would it matter in practice?

**Traps.** Treating p just below 0.05 as proof and just above as no effect.

## Beware of forking paths {#multiple-comparisons}
<!-- terms: multiple comparisons p-hacking forking paths many metrics segments subgroups false discovery correction -->

**Principle.** When testing many metrics, segments or variants, expect false positives, correct for multiple comparisons, and pre-register the primary metric.

**Why.** Test twenty independent metrics at a 5% threshold and one will likely look significant by chance. Slicing data until a segment shows an effect guarantees findings that do not replicate. Pre-registering the primary metric and hypothesis, applying corrections and treating exploratory findings as hypotheses for new tests keeps conclusions honest.

**Signals.** Many metrics or segments examined with the winner reported; analysis choices changed after seeing results.

**Ask.** How many comparisons were made before finding this result, and was it the pre-registered one?

**Traps.** Over-correcting and ignoring genuine consistent signals.

## Design experiments with power {#experiments}
<!-- terms: ab test experiment randomization sample size power duration peeking novelty effect guardrail -->

**Principle.** Size experiments for the effect you need to detect, randomize properly, run for full cycles, avoid peeking-driven stops, and watch guardrail metrics.

**Why.** Underpowered tests produce inconclusive or exaggerated results. Stopping when results look good (peeking) inflates false positives unless sequential methods are used. Weekly cycles and novelty effects bias short tests. Guardrail metrics catch wins on one metric that harm another (conversion up, refunds up).

**Signals.** Tests stopped early on a promising result; no sample-size calculation; experiments shorter than a weekly cycle.

**Ask.** What sample size and duration does detecting the expected effect require?

**Traps.** Running experiments where the decision is already made.

## Communicate findings honestly {#reporting}
<!-- terms: report findings summary caveat limitation conclusion recommendation honest chart -->

**Principle.** Lead with the answer and its confidence, state limitations and assumptions, and separate findings from recommendations.

**Why.** Decision-makers read the first paragraph. Burying caveats leads to overconfident decisions; burying the answer wastes their time. Stating what the analysis cannot show (causation, generalization beyond the sample) is as important as what it shows, because readers will otherwise assume the strongest reading.

**Signals.** Reports with conclusions stronger than the evidence; caveats in footnotes; charts without context.

**Ask.** Does the summary state the answer, how confident we are, and what the analysis cannot conclude?

**Traps.** Hedging so heavily that no conclusion is usable.
