---
id: architecture
part: engineering
title: Architecture and design
summary: Structural decisions: explicit tradeoffs, coupling and cohesion, deep modules, reversibility, data-first design, simplicity budgets and incremental migration.
terms: architecture architect design system structure module service microservice monolith layer boundary interface coupling cohesion tradeoff scalability scale extensible pattern migration rewrite platform framework
tools: project_intel quality_review
skills: software-engineering-wisdom distributed-systems api-design type-driven-design
---

# Architecture and design

Architecture is the set of decisions that are expensive to change. Good architecture is not the most flexible design; it is the one whose rigid parts are the right ones, whose flexible parts are cheap, and whose tradeoffs were chosen on purpose.

## Name the tradeoff you are making {#tradeoffs}
<!-- terms: tradeoff cost benefit alternative option decision consider versus -->

**Principle.** Every design choice buys something with something else; state both sides and why this context favors the choice.

**Why.** Designs presented as simply "better" hide their costs, and the costs arrive later as surprises: operational complexity, latency, consistency anomalies, lock-in. Writing the tradeoff down ("we accept eventual consistency in the feed to keep writes fast") makes the decision reviewable and tells future maintainers which constraints can move. Considering at least one real alternative guards against choosing the first idea by default.

**Signals.** A new service, cache, queue, framework or schema introduced without alternatives or costs mentioned.

**Ask.** What does this design give up, and what alternative was rejected and why?

**Traps.** Endless comparison of options for a reversible choice; tradeoff tables that ignore the team's actual constraints.

## Minimize coupling, maximize cohesion {#coupling}
<!-- terms: coupling cohesion dependency depend tangle change amplification ripple shared module boundary -->

**Principle.** Things that change together belong together; things that change independently should know as little about each other as possible.

**Why.** Coupling determines change amplification: how many places must change for one conceptual change. Tight coupling across modules turns small features into wide, risky diffs and makes testing in isolation impossible. Cohesion groups code by reason to change, so each module has one story. Dependency direction matters too: stable, abstract modules should not depend on volatile, concrete ones.

**Signals.** A small feature requiring edits in many unrelated modules; circular imports; modules reaching into each other's internals.

**Ask.** If this requirement changes again, how many modules must change, and could that number be one?

**Traps.** Splitting cohesive code into many tiny modules in the name of decoupling; introducing indirection with no second implementation.

## Prefer deep modules with narrow interfaces {#deep-modules}
<!-- terms: interface api abstraction module encapsulate hide information hiding simple complex -->

**Principle.** A good module hides substantial complexity behind a small, stable interface; shallow wrappers that expose everything add cost without value.

**Why.** The benefit of a module is the complexity it removes from its callers. A module whose interface is as complex as its implementation (pass-through layers, getters for every field, configuration objects exposing internals) forces callers to understand both. Deep modules—file systems, HTTP clients, good ORMs—offer a few powerful operations and absorb the hard parts. Information hiding also lets the implementation change without touching callers.

**Signals.** Layers that only forward calls; interfaces mirroring internal data structures; callers needing to know the order of internal steps.

**Ask.** What complexity does this module hide from its callers, and could its interface be smaller?

**Traps.** Hiding details callers genuinely need (errors, performance characteristics); god objects mistaken for deep modules.

## Distinguish one-way doors from two-way doors {#reversibility}
<!-- terms: reversible irreversible decision commit lock-in migration schema public api format -->

**Principle.** Move fast on decisions that are cheap to reverse; slow down, prototype and review the ones that are not.

**Why.** Public APIs, persisted data formats, database schemas, security models and vendor commitments are one-way doors: once others depend on them, reversal is costly. Internal code structure, naming and most library choices are two-way doors. Treating everything as irreversible causes paralysis; treating everything as reversible produces lock-in by accident. Reversibility can often be engineered: versioned formats, feature flags, adapters around vendors.

**Signals.** New persisted formats, public endpoints, schema changes or external contracts created casually; heavy deliberation over internal refactors.

**Ask.** If this turns out wrong in three months, what does undoing it cost, and who else will depend on it by then?

**Traps.** Using "reversible" to justify skipping design for things that will quickly gain dependents.

## Design the data first {#data-first}
<!-- terms: data model schema entity relationship state shape type domain persistence -->

**Principle.** Get the data model right—entities, relationships, invariants, lifecycle—and much of the code follows; the schema outlives the code.

**Why.** Code can be rewritten in a weekend; data accumulated for years cannot be casually reshaped. A model that represents the domain faithfully makes invalid states unrepresentable and queries natural. A poor model forces every feature to compensate with special cases. Invariants belong in the model (types, constraints, uniqueness) rather than scattered in business logic.

**Signals.** Features fighting awkward data shapes; nullable fields encoding several states; the same concept stored differently in different places.

**Ask.** Does the data model make the invalid states of this domain impossible to represent?

**Traps.** Over-normalizing for theoretical purity; designing a universal model for hypothetical future products.

## Spend the complexity budget deliberately {#simplicity}
<!-- terms: simple simplicity complexity yagni overengineering premature boring technology framework new tool -->

**Principle.** Every new moving part must pay for itself now; choose boring, well-understood technology unless a real requirement demands otherwise.

**Why.** Complexity compounds: each new service, queue, cache or framework adds failure modes, operational burden and onboarding cost for as long as it exists. Speculative generality ("we might need to scale this") usually targets the wrong future. Mature technology has known failure modes and answers on the internet. The strongest designs are those where a newcomer can predict how things work.

**Signals.** New infrastructure or frameworks for a small feature; configuration for variations nobody asked for; plugin systems with one plugin.

**Ask.** What concrete requirement today justifies this extra component, and what is the simplest design that meets it?

**Traps.** Under-engineering known hard requirements (security, data integrity) in the name of simplicity.

## Evolve systems incrementally {#migration}
<!-- terms: migration migrate rewrite legacy strangler incremental feature flag rollout parallel run cutover -->

**Principle.** Replace systems piece by piece behind stable seams—strangler patterns, feature flags, parallel runs—never by big-bang rewrite.

**Why.** Rewrites discard years of encoded edge cases and deliver no value until the end, when they are compared against a moving target. Incremental migration keeps the system working at every step, delivers value early and allows rollback. Running old and new paths in parallel and comparing outputs is the most reliable way to prove equivalence before switching.

**Signals.** Plans to replace a working subsystem wholesale; migrations with no rollback path; old and new code paths with no comparison.

**Ask.** Can this change ship in steps that each leave the system working and reversible?

**Traps.** Migrations that never finish, leaving two systems forever; flags that are never removed.
