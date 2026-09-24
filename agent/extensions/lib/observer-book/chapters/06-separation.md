---
id: separation
part: engineering
title: Separation of concerns and placement
summary: Where code and concepts belong: one reason to change per unit, layers and ports, domain versus infrastructure, feature folders, configuration versus code, presentation versus logic versus data.
terms: separation concern concerns placement place belong layer layers layering folder structure organize organization module package directory domain infrastructure presentation logic business view controller model component hexagonal ports adapters clean architecture responsibility responsibilities
tools: project_intel workspace_search
skills: software-engineering-wisdom coding-practices design-systems web-component-patterns
---

# Separation of concerns and placement

Every piece of code answers two questions: what does it do, and where does it live. Most maintainability problems are placement problems: business rules inside UI handlers, SQL inside view templates, configuration hardcoded in logic, a "utils" folder that owns half the domain. Separation of concerns is the discipline of giving each concept one home, chosen by what makes it change.

## One reason to change per unit {#one-reason}
<!-- terms: single responsibility reason change unit class module function srp -->

**Principle.** Group code by the reason it changes; a module that changes for two unrelated reasons should be two modules.

**Why.** Code that mixes concerns—formatting and pricing, transport and business rules—changes for every reason any of its concerns changes, so every edit risks unrelated behavior. When units change for one reason, changes stay local, tests stay focused, and ownership is clear. The test is practical: list the kinds of requirement changes that would touch this file; if the list spans different stakeholders (designers, finance, infrastructure), the file mixes concerns.

**Signals.** One file edited for unrelated features; functions mixing I/O, parsing, business decisions and rendering; classes named Manager or Helper with broad methods.

**Ask.** What different kinds of requirement changes would force edits to this unit?

**Traps.** Splitting cohesive logic into fragments that must always change together; mistaking file count for separation.

## Keep the domain independent of delivery and storage {#domain-core}
<!-- terms: domain core business logic infrastructure database http framework ports adapters hexagonal clean dependency inversion -->

**Principle.** Business rules should not know whether they are called from HTTP, a CLI or a queue, or whether data lives in Postgres or a file; infrastructure depends on the domain, not the reverse.

**Why.** Domain logic is the most valuable and longest-lived code; frameworks, databases and transports churn. When rules are entangled with request objects or ORM entities, every framework upgrade becomes a rewrite and every rule needs a database to test. Ports-and-adapters (hexagonal) or "functional core, imperative shell" designs put pure decisions in the center and side effects at the edges. The payoff: fast tests for rules, swappable infrastructure, and rules that read like the business.

**Signals.** Request or ORM objects passed deep into logic; business rules that cannot run without a database or server; framework imports in core modules.

**Ask.** Could this business rule be tested without a network, database or framework, and if not, what couples it?

**Traps.** Ceremony-heavy layering for simple CRUD apps; abstract repositories with one implementation and no tests benefiting.

## Organize by feature, not by technical kind, when the app grows {#feature-folders}
<!-- terms: folder structure feature folders by type controllers models views directory organize colocate colocation -->

**Principle.** As a codebase grows, colocate what changes together—a feature's UI, state, API calls and tests—instead of scattering them across global controllers/, models/, views/ folders.

**Why.** Organizing by technical kind makes every feature change touch many distant folders and hides which code belongs to which feature, making deletion scary and ownership vague. Feature (or domain) folders make the blast radius of a change visible and allow removing a feature by deleting a directory. Shared, truly generic code still lives in a common area, but only after it is actually shared.

**Signals.** A small feature change editing files in five top-level folders; a growing utils or common folder with feature-specific logic.

**Ask.** If this feature were removed, how many directories would need edits?

**Traps.** Premature restructuring of small projects; fighting a framework's required conventions.

## Separate configuration from code {#config}
<!-- terms: configuration config environment variable settings hardcoded constant magic number secret url endpoint -->

**Principle.** Values that vary by environment or deployment—URLs, credentials, limits, feature flags—belong in configuration with safe defaults, not hardcoded in logic.

**Why.** Hardcoded environment values force code changes for deployments, leak secrets into repositories and create "works on my machine" bugs. But over-configuration is also harmful: making every constant configurable multiplies untested combinations. The rule: configure what legitimately differs between environments or users; keep true constants (algorithm parameters, protocol values) as named constants in code with a comment explaining them.

**Signals.** Literal URLs, ports, API keys or paths in source; dozens of configuration knobs nobody changes; magic numbers without names.

**Ask.** Does this value differ between environments or users, and if not, is it at least a named constant?

**Traps.** Configurability as a substitute for decisions; configs without validation that fail late.

## Presentation, logic and data are different jobs {#presentation}
<!-- terms: presentation view template component render ui logic data fetch state store mvc mvvm -->

**Principle.** Components render; logic decides; data layers fetch and persist. Keep each job in its own layer so each can change and be tested alone.

**Why.** UI components that fetch data, compute business rules and format output are hard to reuse, test or restyle; changing the backend breaks the view and redesigning the view risks the rules. Splitting container logic (data, state transitions) from presentational components (props in, markup out) makes design changes safe and logic testable without rendering. The same split applies server-side: templates should not query databases.

**Signals.** fetch or SQL calls inside rendering code; business calculations duplicated across components; components impossible to render in isolation or in a story.

**Ask.** Could this component be rendered with plain props in isolation, and where do its business rules live?

**Traps.** Splitting trivial components into three files; prop drilling mistaken for separation.

## Name the seams; make boundaries explicit {#seams}
<!-- terms: boundary interface contract seam api module public private export internal -->

**Principle.** Every module boundary should have an explicit, minimal public surface; everything else is private and free to change.

**Why.** When everything is exported, everything is depended on, and no internal can change without breaking someone. Explicit boundaries—index files, public interfaces, package exports, clear "internal" namespaces—tell collaborators what is stable. They also document the module's purpose: the public surface is the module's promise. Reviews can then focus on changes to the surface.

**Signals.** Deep imports into another module's internals; everything exported "just in case"; circular dependencies across modules.

**Ask.** What is this module's public surface, and do callers reach past it?

**Traps.** Wrapping every internal in getters to look encapsulated.

## Cross-cutting concerns deserve a single mechanism {#cross-cutting}
<!-- terms: logging auth authorization caching metrics tracing error handling middleware decorator aspect cross-cutting -->

**Principle.** Logging, authorization, caching, metrics and error translation should be applied through one consistent mechanism—middleware, decorators, interceptors—rather than copied into every function.

**Why.** Cross-cutting concerns copied by hand drift: one endpoint forgets the auth check, another logs secrets, a third swallows errors differently. A single mechanism applies policy uniformly and makes audits possible ("show me every route without auth"). It also keeps business code readable because it no longer carries infrastructure noise.

**Signals.** Repeated boilerplate for auth or logging in every handler; inconsistent error formats across endpoints; missing checks on some routes.

**Ask.** Is this policy applied by one mechanism everywhere, or copied by hand where someone remembered?

**Traps.** Magic middleware nobody can trace; hiding business-relevant decisions inside infrastructure hooks.
