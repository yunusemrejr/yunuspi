---
id: math
part: science
title: Mathematics for builders
summary: The mathematics that keeps software right: floating point and numerical stability, units and dimensional analysis, estimation, probability, linear algebra and geometry intuition, discrete math and proofs, and optimization.
terms: math mathematics equation formula calculate calculation compute float floating point precision rounding decimal numeric numerical stability overflow units dimension estimate estimation probability matrix vector linear algebra geometry trigonometry angle proof invariant induction optimization gradient derivative integral modulo
tools: math_check sandbox_run
skills: numerical-computing optimization-modeling physics-modeling statistical-experiments algorithm-design
---

# Mathematics for builders

Software is applied mathematics whether or not it looks like it: prices are rational numbers, timestamps are integers with units, graphics are linear algebra, recommendations are probability. The math that matters most for builders is less about advanced theory than about not getting the basics silently wrong.

## Floating point is not real arithmetic {#floating-point}
<!-- terms: float floating point double precision rounding 0.1 0.2 epsilon decimal money currency compare equality -->

**Principle.** Never use binary floating point for money or exact decimal quantities, never compare floats with ==, and know where rounding error accumulates.

**Why.** 0.1 + 0.2 is not 0.3 in binary floating point; errors accumulate in long sums and cancellation destroys precision when subtracting nearly equal numbers. Money needs integer minor units or decimal types with explicit rounding rules. Comparisons need tolerances relative to magnitude. Summation order matters; compensated (Kahan) summation reduces error.

**Signals.** Currency stored as floats; equality comparisons on computed floats; large sums of small values.

**Ask.** Is this quantity exact (money, counts) or measured, and does the representation match?

**Traps.** Rounding at each step instead of once at the end; tolerance values that are absolute when they should be relative.

## Check units and dimensions {#units}
<!-- terms: units dimension dimensional analysis seconds milliseconds bytes kilobytes meters conversion scale factor -->

**Principle.** Carry units explicitly—in names, types or libraries—and check that every formula's dimensions balance.

**Why.** Unit confusion causes some of the most expensive bugs in history. In software it looks like milliseconds passed where seconds are expected (timeouts 1000 times too long), kibibytes versus kilobytes, degrees versus radians, or per-second rates multiplied by minutes. Naming variables with units (timeoutMs, sizeBytes) and doing dimensional analysis on formulas catches these mechanically.

**Signals.** Numeric parameters without units in names; conversions by magic numbers; trigonometry mixing degrees and radians.

**Ask.** What are the units of each quantity in this formula, and do they balance?

**Traps.** Units documented in comments that drift from the code.

## Estimate before you compute {#estimation}
<!-- terms: estimate estimation fermi back of the envelope order of magnitude sanity check approximate -->

**Principle.** Make a back-of-the-envelope estimate of the expected result before computing or measuring, and investigate when reality differs by an order of magnitude.

**Why.** Fermi estimation—multiplying rough factors—gives the right order of magnitude quickly, which is often enough for decisions (will this fit in memory, how long will this take, is this number plausible). It also detects errors: a computed result 1000 times off an estimate usually means a unit mistake or bug. Knowing reference numbers (memory and disk latencies, network round trips, typical throughputs) makes estimates fast.

**Signals.** Results accepted without a plausibility check; capacity decisions without any estimate.

**Ask.** What order of magnitude did we expect, and does the result match it?

**Traps.** Treating an estimate as a measurement.

## Think in probabilities and base rates {#probability}
<!-- terms: probability base rate bayes conditional independent expected value risk rare event false positive -->

**Principle.** Reason with base rates and conditional probabilities; rare events at scale are not rare, and independence assumptions need justification.

**Why.** A test with 99% accuracy for a condition with 0.1% prevalence produces mostly false positives (Bayes' theorem). A one-in-a-million bug occurs thousands of times a day at a billion requests. Assuming independence (disk failures, retries, correlated outages) underestimates joint risk. Expected value frames decisions under uncertainty better than best or worst cases alone.

**Signals.** Risk dismissed as "unlikely" without volume considered; alerts with high false-positive rates; independence assumed for correlated failures.

**Ask.** Given the base rate and volume, how often will this actually happen?

**Traps.** Precise-looking probabilities built on guessed inputs.

## Linear algebra and geometry intuition {#linear-algebra}
<!-- terms: vector matrix transform rotation translation scale dot product cross product normalize coordinate space quaternion -->

**Principle.** Treat transforms as matrices applied in a defined order and coordinate space; normalize vectors when direction matters and keep spaces explicit.

**Why.** Graphics, layout, physics and machine learning all rest on linear algebra. Most bugs are order and space confusions: rotating then translating differs from translating then rotating; mixing world and local coordinates; forgetting to normalize before dot products; gimbal lock with Euler angles (quaternions avoid it). Naming spaces in variables (worldPos, localPos) prevents many errors.

**Signals.** Transform composition in inconsistent orders; unnormalized vectors used as directions; positions mixed across coordinate spaces.

**Ask.** In which coordinate space is each vector, and in what order are these transforms applied?

**Traps.** Hand-rolled matrix code where a library exists.

## State invariants and prove small things {#invariants}
<!-- terms: invariant proof induction loop invariant precondition postcondition termination correctness reasoning -->

**Principle.** For tricky logic, write the invariant the code maintains, and reason briefly about why it holds initially, is preserved by each step and implies the result.

**Why.** Informal proofs catch bugs that tests miss because they cover all inputs, not samples. Loop invariants make off-by-one errors obvious; termination arguments catch infinite loops; induction explains recursive correctness. This takes minutes and is most valuable for concurrency, algorithms, and security-sensitive checks.

**Signals.** Complex loops or recursion without a stated invariant; bugs fixed by adjusting indices until tests pass.

**Ask.** What invariant does this code maintain, and why does it hold after every step?

**Traps.** Formal proof of trivial code while complex parts remain unexamined.

## Optimization problems deserve optimization methods {#optimization}
<!-- terms: optimization optimize minimize maximize constraint linear programming solver heuristic greedy search objective -->

**Principle.** When a task is choosing the best option under constraints—scheduling, allocation, routing, packing—formulate the objective and constraints and use a solver or a known heuristic.

**Why.** Hand-written greedy logic for optimization problems produces plausible but poor answers and breaks when constraints change. Many such problems map directly to linear or integer programming, constraint satisfaction or known heuristics with quality guarantees. Writing the objective explicitly also clarifies what "best" means, which is often the real disagreement.

**Signals.** Nested loops searching combinations; ad hoc scheduling rules growing with each new constraint.

**Ask.** What exactly is being minimized or maximized, under which constraints, and is there a standard method for it?

**Traps.** Using a heavyweight solver for small problems solvable by enumeration.
