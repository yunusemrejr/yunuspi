# Evidence and implementation review

## Code
- Verify APIs against installed types, implementation or versioned documentation. Plausible names are not evidence.
- Keep one owner for a concern. Reuse an existing boundary before adding another helper, policy layer or dependency. A single-use abstraction can still isolate a meaningful invariant.
- Check failure propagation, cleanup, cancellation and input boundaries where relevant. Do not add universal retries or blanket catch blocks.
- Tests should distinguish correct behavior from a plausible broken implementation. Avoid assertions that merely restate the code.
- Remove unused scaffolding and comments that obscure intent. Keep explanations of constraints, non-obvious choices and public contracts.

## Writing and evidence
Read `../natural-editorial-writing/SKILL.md` when prose is central. Prefer supported specifics over confidence language. Do not manufacture citations, benchmark results, customer stories or causal claims. Label synthetic examples and separate measurements from estimates. Repetition needed for technical precision is legitimate.


For a failed request, trace the state transition and error owner rather than adding another retry wrapper. Check whether cancellation is distinct from failure. For a benchmark claim, record the command, workload, environment and comparison baseline; a successful build is not evidence of a speed improvement. For an API integration, test a representative invalid response as well as the expected response. Do not rename ordinary variables or extract functions merely to make a diff appear sophisticated. Review whether another maintainer can locate the behavior and understand the contract.

## Reference entry points
Use the installed project's types and tests first. For documentation and accessible behavior, consult https://developers.google.com/style and https://www.w3.org/WAI/ARIA/apg/ as relevant; these links are reference entry points, not claims that a particular artifact conforms.

## Select checks by the changed contract
For identity or permission changes, exercise an unauthorized case. For stored data, consider existing records and old readers. For queues and caches, consider repeated requests, invalidation and cancellation. For numeric work, establish units, representative scales and an independent reference result. For ML changes, check split provenance, leakage and comparison against a simple baseline. For interfaces, verify a realistic interaction state as well as appearance. These are selection rules, not requirements to run every check for every task.

A review finding needs a location, a triggering case and a consequence. Track uncertainty explicitly. A suspicious pattern may justify one targeted inspection; it does not justify a rewrite or repeated review loops. Once the relevant checks pass, deliver the result and disclose any material verification limits.
