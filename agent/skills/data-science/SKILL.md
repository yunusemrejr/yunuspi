---
name: data-science
description: "Data and scientific computing: Postgres schema, transactions and migrations; data analysis and lineage; honest charts; numerical methods; simulation and physics; optimization; A/B and statistical experiments."
---

# Data science and computation

## Databases and SQL
- Postgres by default; Redis is a cache, not storage.
- About 3NF; explicit `ON DELETE` on every FK; `timestamptz` UTC; `numeric` for money; `bigint identity` or `uuidv7` keys, never random `uuidv4` clustered keys.
- Index hot `WHERE`/`JOIN`/`ORDER BY` patterns, equality columns first. `EXPLAIN (ANALYZE, BUFFERS)` runs the statement: use a copy for writes.
- Keyset pagination, not large `OFFSET`; batch N+1 loads.
- Never select-then-update a shared row: use `FOR UPDATE` or atomic `UPDATE ... WHERE` checked by rowcount. Retry `40001` and `40P01` with bounded jittered backoff; no network I/O inside transactions.
- Migrations: forward-only; expand, chunked backfill, contract. `CREATE INDEX CONCURRENTLY` cannot run in a transaction. Test on prod-shaped data. A backup counts only after a restore test.
- `NOT IN` with NULLs misbehaves; use `NOT EXISTS`. A WHERE filter on a LEFT JOIN's nullable side makes it an inner join.

## Analysis and lineage
- Pin the question: population, numerator and denominator, window, grain, decision.
- Profile in code: counts, nulls, duplicate keys, date gaps, units, timezones. Keep missing, zero and filtered rows distinct.
- Log each exclusion with a count; check join cardinality before aggregating; tie each number to a query or source.
- Recompute the headline a second way; a too-good result is a bug first.
- Medians for skewed data; show denominators; check mix shifts (Simpson's paradox); correlation is a lead, not cause.

## Charts and dashboards
- Chart by question: sorted bars for magnitudes, lines for trends, histograms for distributions, scatter for relationships, KPI number plus delta; table under ~10 exact values.
- Bars start at zero; no dual axes for different units; never sort a time series; break lines at gaps; state the aggregation unit.
- Okabe-Ito for up to six categories; viridis for sequential; never encode by red/green alone.
- Dashboards: one hero answer top-left; six to eight panels, each stating window and freshness. No data is not zero. Every KPI shows a reference.
- Give each chart an aria-label with its takeaway. No 3D or gauges.

## Numerical computing
- Fix shapes, units, domain and tolerance; test a tiny case with a known answer.
- Solve rather than invert; scale inputs; reject nonfinite values at their origin, not by clipping.
- Small residuals can hide large error on ill-conditioned matrices; perturb inputs. Check derivatives by finite differences: autodiff matches the code, not the math.
- Repeat at tighter tolerance or higher precision; report precision used.

## Simulation and physics
- Specify boundary, state, units, rules, intended use; an explanatory animation is not validated.
- Fixed simulation steps; rendering never changes physics; seedable RNGs; log config.
- Check a closed-form or equilibrium case, conservation and energy drift as the step shrinks. Symplectic integrators suit only Hamiltonian systems.
- Check dimensions and limits; density matrices: Hermitian, trace one, positive semidefinite.
- Stochastic models need independent replications; calibrate and validate on separate data.

## Optimization
- Write variables, domains, objective direction, constraints and units; confirm the objective is the real goal.
- Test feasible and infeasible tiny instances. Claim global optimality only from convexity or proof, not a solver's success flag.
- Recheck constraints after rounding (a relaxed allocation can break capacity); report solver status and tolerance.

## A/B and statistical experiments
- Before looking, fix the estimand, randomization unit, primary metric and practical effect threshold. Repeated measures from one user are not independent users.
- Check sample-ratio mismatch (chi-square) first; p < 0.001 means broken assignment or logging.
- Size before launch: about 16 * p(1-p) / delta^2 per arm at 80% power, alpha 0.05. Run full weeks; no peeking unless a sequential method was chosen upfront.
- Ratio metrics need the delta method or bootstrap at the randomization unit; correct secondary metrics or label them exploratory.
- Report effect with 95% interval, counts, duration, SRM result and ship/iterate/stop decision; nonsignificance is not equivalence.
