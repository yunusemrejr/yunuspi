---
id: product
part: business
title: Product thinking
summary: Building the right thing: problems and jobs to be done, smallest valuable slices, success metrics defined in advance, prioritization, time to first value, and learning from real users.
terms: product feature features user users customer customers problem job to be done jtbd mvp roadmap priority prioritize prioritization scope requirement requirements metric metrics success onboarding activation retention feedback persona use case value
tools: todo research_toolkit
skills: resourceful-market-strategy storytelling product-ui-verification ui-ux-principles
---

# Product thinking

Product thinking asks, before how to build something, whether it should be built and what "working" means for the people who use it. It connects engineering effort to user outcomes and protects teams from building polished answers to the wrong questions.

## Start from the problem and the job {#problem}
<!-- terms: problem job to be done jtbd user need pain outcome motivation situation -->

**Principle.** Describe the user's situation, motivation and desired outcome—the job they hire the product to do—before describing features.

**Why.** Feature requests are users' guesses at solutions. The underlying job ("when I get a new lead, I want to respond before competitors so I win the deal") reveals better solutions and the criteria for success. Jobs are stable while solutions change, and competitors are defined by the job, not the category: a spreadsheet competes with every workflow tool.

**Signals.** Requirements expressed only as features; no statement of who has the problem or why it matters.

**Ask.** What job is the user trying to get done, and how will this feature make that job easier?

**Traps.** Abstract jobs so broad they guide nothing.

## Ship the smallest valuable slice {#slice}
<!-- terms: mvp minimum viable slice scope iteration increment thin vertical slice first version -->

**Principle.** Deliver the thinnest end-to-end slice that solves a real part of the problem for real users, then iterate—minimal scope, not minimal quality.

**Why.** Large up-front builds bet everything on untested assumptions. A vertical slice (one complete path through UI, logic and data) produces feedback from reality early and exposes integration problems. But an MVP that is buggy or confusing tests nothing except tolerance for bad products; the slice should be small and good.

**Signals.** Horizontal phases (all backend, then all frontend) before anything is usable; feature lists growing before first release.

**Ask.** What is the smallest complete path a user could use to get value, and when can they have it?

**Traps.** Slices too thin to deliver any real value.

## Define success before building {#metrics}
<!-- terms: success metric metrics kpi leading lagging outcome goal target measure activation adoption -->

**Principle.** Before building, state how success will be measured—a leading indicator soon after launch and a lagging outcome later—and instrument it.

**Why.** Without predefined success criteria, every launch is declared a success. Leading indicators (activation, adoption of the feature, task completion) give fast signal; lagging outcomes (retention, revenue, support tickets) confirm value. Instrumentation added after launch misses the baseline.

**Signals.** Features shipped without analytics events or defined goals; success judged by anecdote.

**Ask.** Which metric would show this feature worked, what is its baseline, and is it instrumented?

**Traps.** Vanity metrics (page views, sign-ups) standing in for value.

## Prioritize by impact, confidence and effort {#prioritize}
<!-- terms: prioritize prioritization impact effort confidence rice ice backlog roadmap trade-off say no -->

**Principle.** Rank work by expected impact, the confidence behind that estimate and the effort required; say no, or not yet, to the rest.

**Why.** Every yes is a no to something else. Frameworks like RICE or ICE make assumptions explicit and comparable, and confidence penalizes wishful thinking. Saying no is how focus is maintained; the most valuable roadmaps are short, and each item on them has a stated reason to exist now rather than later.

**Signals.** Many parallel initiatives; work chosen by who asked loudest; no explicit trade-offs.

**Ask.** Compared to the alternatives, what impact, confidence and effort does this work have?

**Traps.** False precision in scoring.

## Minimize time to first value {#first-value}
<!-- terms: onboarding time to value activation first run setup empty state aha moment sign up friction -->

**Principle.** Get new users to their first meaningful success as fast as possible; every setup step before value is a place they leave.

**Why.** Users decide quickly whether a product is worth their time. Long sign-up forms, mandatory configuration, empty dashboards and tours delay the "aha" moment. Sample data, templates, smart defaults and deferring optional setup accelerate it. Measuring the funnel from sign-up to first success shows where users drop.

**Signals.** Onboarding requiring many steps before any value; empty initial states; required fields that could be deferred.

**Ask.** How many steps separate a new user from their first success, and which could be removed or deferred?

**Traps.** Skipping steps that are actually necessary for success.

## Learn from real users, not proxies {#user-feedback}
<!-- terms: user research interview feedback usability test observe behavior analytics survey customer -->

**Principle.** Watch real users attempt real tasks, and weigh observed behavior above stated preferences.

**Why.** What people say they want differs from what they do. Five usability sessions reveal most major problems; analytics show where many users struggle but not why; interviews explain motivations. Internal teams are poor proxies because they know too much. Asking about past behavior ("last time you did X, what happened?") beats hypotheticals.

**Signals.** Decisions based on internal opinions only; surveys asking what users would want; no usability testing.

**Ask.** What did real users actually do when trying this?

**Traps.** Over-weighting the loudest customers.
