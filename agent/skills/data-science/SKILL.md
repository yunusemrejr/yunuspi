---
name: data-science
description: "Data and scientific computing: Postgres schema, transactions and migrations; data analysis and lineage; honest charts; numerical methods; simulation and physics; optimization; A/B and statistical experiments."
disable-model-invocation: true
---

# Data and scientific computing

A number in a report is a claim someone will act on: it comes from the data, by a method that can be rerun, in proportion to what the data supports. Quoting a sourced figure is research.

## Look before you summarize
- Get the raw data, not a summary. Open real rows from the start, middle and end plus the smallest and largest values. Record where it came from (file, query, export date, window, version); if it cannot be reached the answer is "unavailable"; synthetic data is labeled synthetic.
- Per column: type, unit, currency, allowed range, share of nulls; missing, zero, filtered out and never collected are four different facts. Per table: what one row is, the key, and whether the key is truly unique. Count and inspect duplicates; do not hide them with `DISTINCT`.
- Time: store in UTC, name the zone of every displayed date, watch DST days (23 and 25 hours) and window edges. Money: one currency per total, rate and its date stated, integer minor units or decimals.

## Joins and denominators
- Before a join count rows and distinct keys on both sides and predict the result (one-to-one, one-to-many, many-to-many); compare after. A one-to-many join repeats parent values: aggregate to the intended grain first. Write the denominator beside every rate ("12 of 340, 3.5%") and say what it excludes.

## Compute in code
- Every consequential number comes from a script or query that can be rerun; never arithmetic by head or from a chart screenshot. Keep script and output with the report and name the source and command behind each number.
- Reconcile: parts add up to the total, the total matches the source system, row counts after each step match expectation. A mismatch is a finding, not a rounding detail.
- Investigate implausible figures before reporting: a rate over 100%, a negative count, a sudden jump, an identical value in every row, mean far from median. Check units, join, filter and window first, then the raw records behind the outlier.
- Never invent, silently estimate or round away a figure; round only for display. Numerical work: test a tiny case with a known answer, keep units in variable names, solve linear systems instead of inverting, reject NaN or infinity where it first appears.
- Postgres and schemas: constraints in the database, explicit transactions, migrations that are safe to rerun with a rollback.

## Observed, calculated, assumed
Label each statement: observed (read from the data), calculated (derived by the script), assumed (with the reason). A plausible explanation is a hypothesis until a check supports it.

## Statistical claims in proportion
- Fix the question first: population, comparison, outcome, window, unit of analysis (repeated rows from one user are not independent). Report effect size with its uncertainty, the sample size and how the interval was computed; a p-value alone says nothing about size.
- Many comparisons produce chance findings: state how many were tried and correct, or label the result exploratory. No significant difference is not proof of none; correlation is not cause. Compare like with like (a latency change may be a traffic-mix change); randomize or match the workload.
- Stochastic results (benchmarks, models): several runs, mean and spread, evaluation on data kept apart from tuning, score the real outcome. A/B tests: fixed sample or sequential rule decided before looking. Small samples and one-off runs are stated as such.

## Handing over
- Answer first, key figures with denominators, then sources and commands, assumptions, and what could not be checked. Spreadsheets go through the xlsx skill and charts through dataviz, with the computed rows. For a non-technical reader say what the number means before the method. Large inputs: read in chunks, time a sample first.
