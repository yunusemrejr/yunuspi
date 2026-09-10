---
name: statistical-experiments
description: Design and analyze controlled experiments, uncertainty estimates and causal comparisons; use for A/B tests or deciding whether a measured improvement is real.
---

# Statistical Experiments

Define the estimand: population, intervention/comparison, outcome, observation window and unit of analysis. Separate descriptive association from a causal conclusion.

1. Establish the assignment mechanism and likely confounders. For randomized work choose the unit that avoids interference; repeated measurements from one user are not independent users.
2. Set the primary outcome, practical effect threshold and stopping rule before looking for significance. Keep exploratory findings labeled exploratory.
3. Check missingness, attrition, sample-ratio mismatch, time trends and contamination. Explain exclusions; do not silently filter inconvenient outcomes.
4. Estimate effect size and uncertainty using a method compatible with sampling, clustering and distribution. Resample at the independent unit when bootstrapping. Correct for planned multiple comparisons when relevant.
5. Report counts, denominators, interval assumptions and robustness checks. Nonsignificance is not proof of equivalence; observational adjustment alone does not establish causality.

Example: comparing request latency across two versions can be confounded by different traffic mixes. Match workload or randomize assignment before attributing the change to code.

Deliver the analysis script and a decision justified by practical effect and uncertainty, not a p-value alone. Do not manufacture sample size or confidence intervals.
