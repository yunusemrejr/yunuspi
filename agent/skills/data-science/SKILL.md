---
name: data-science
description: "Data and scientific computing: SQL and Postgres schema, indexes, transactions and migrations; data analysis and lineage; honest charts; numerical methods; simulation and physics models; optimization; A/B and statistical experiments."
---

# Data science and computation

## Databases and SQL
- Default to Postgres; other stores need a measured reason. Redis is a cache, not storage.
- About 3NF; explicit `ON DELETE` on every FK; `timestamptz` UTC; `numeric` for money; `bigint identity` or `uuidv7` keys, never random `uuidv4` clustered keys.
- Index hot `WHERE`, `JOIN` and `ORDER BY` patterns, equality columns first. `EXPLAIN (ANALYZE, BUFFERS)` executes the statement: use a copy for writes.
- Keyset pagination, not large `OFFSET`; batch N+1 loads.
- Never select-then-update a shared row: use `FOR UPDATE` or an atomic `UPDATE ... WHERE` checked by rowcount. Retry `40001` and `40P01` with jitter; no network I/O inside transactions.
- Migrations: forward-only; expand, chunked backfill, contract. `CREATE INDEX CONCURRENTLY` cannot run in a transaction. Test on prod-shaped data. A backup counts only after a restore test.
- `NOT IN` with NULLs misbehaves; use `NOT EXISTS`. A WHERE filter on a LEFT JOIN's nullable side makes it an inner join.

## Analysis and lineage
- Pin the question: population, numerator and denominator, window, grain, decision.
- Profile in code: counts, nulls, duplicate keys, date gaps, units, timezones. Keep missing, zero and filtered rows distinct.
- Log each exclusion with a count; check join cardinality before aggregating; tie each reported number to a query or source.
- Recompute the headline a second way; a too-good result is a bug first.
- Medians for skewed data; show denominators; check mix shifts (Simpson's paradox). Correlation is a lead, not a cause.

## Charts and dashboards
- Pick the chart by the question: sorted bars for magnitudes, lines for trends, histograms for distributions, scatter for relationships, a number with delta for one KPI. Under about 10 exact values, use a table.
- Bars start at zero; no dual axes for different units; never sort a time series; break lines across gaps; state the aggregation unit.
- Okabe-Ito for up to six categories; viridis for sequential; never encode by red/green alone.
- Dashboards: one hero answer top-left; six to eight panels, each stating window and freshness. No data is not zero. Every KPI shows a reference.
- Give each chart an aria-label with its takeaway. No 3D or gauges.

## Numerical computing
- Fix shapes, units, domain and tolerance; test a tiny case with a known answer.
- Solve rather than invert; scale inputs; reject nonfinite values at their origin, not by clipping.
- Small residuals can hide large error on ill-conditioned matrices: perturb inputs. Check derivatives by finite differences; autodiff matches the code, not the intended math.
- Repeat at tighter tolerance or higher precision; report the precision used.

## Simulation and physics
- Specify boundary, state, units, rules and intended use. An explanatory animation is not a validated model.
- Fixed simulation steps; rendering never changes physics; seedable RNGs; log configuration.
- Check a closed-form or equilibrium case, conservation and energy drift as the step shrinks. Symplectic integrators bound energy error only for suitable Hamiltonian systems.
- Check dimensions and limiting cases; density matrices: Hermitian, trace one, positive semidefinite.
- Stochastic models need independent replications. Calibrate and validate on separate data; refine grids against an independent reference.

## Optimization
- Write variables, domains, objective direction, constraints and units; confirm the objective is the real goal.
- Test feasible and infeasible tiny instances. Claim global optimality only from convexity or a proof, not a local solver's success flag.
- Recheck every constraint after rounding; rounding a relaxed allocation can break capacity. Report solver status and tolerance.

## A/B and statistical experiments
- Before looking, fix the estimand, randomization unit, primary metric and practical effect threshold. Repeated measures from one user are not independent users.
- Check sample-ratio mismatch with a chi-square test first; p < 0.001 means broken assignment or logging.
- Size before launch: about 16 * p(1-p) / delta^2 per arm at 80% power, alpha 0.05. Run full weeks; no peeking unless a sequential method was chosen upfront.
- Ratio metrics need the delta method or a bootstrap at the randomization unit. Correct secondary metrics or label them exploratory.
- Report effect with a 95% interval, counts, duration, SRM result and a ship, iterate or stop decision. Nonsignificance is not equivalence.
