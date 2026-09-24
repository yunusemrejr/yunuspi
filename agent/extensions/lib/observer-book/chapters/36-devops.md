---
id: devops
part: operations
title: DevOps and infrastructure
summary: Running software reliably: infrastructure as code, containers done right, environment parity, secrets management, observability and SLOs, safe deployments, incident response and cost-aware operations.
terms: devops infrastructure infra iac terraform pulumi ansible docker dockerfile container containers image kubernetes k8s helm compose deploy deployment deployments production staging environment cloud aws gcp azure cloudflare vercel monitoring alert alerting slo sli incident outage rollback canary blue green observability prometheus grafana
files: dockerfile docker-compose.yml .tf .tfvars /k8s/ /helm/ /deploy/ /infra/
tools: sys_probe workflow_probe env_audit
skills: ubuntu-operations cloudflare-platform-engineering github-actions-workflows multi-developer-pipelines linux-host-defense
---

# DevOps and infrastructure

Operations turns code into a service people can rely on. Its doctrine is automation over memory, small reversible changes over big releases, measurement over hope, and blameless learning over heroics.

## Infrastructure as code, reviewed like code {#iac}
<!-- terms: infrastructure as code terraform pulumi ansible cloudformation state plan apply drift manual console -->

**Principle.** Define infrastructure in version-controlled code, review plans before applying, and avoid manual console changes that create drift.

**Why.** Manually configured infrastructure is undocumented, unreproducible and fragile: nobody remembers which setting fixed the outage last year. Infrastructure as code makes environments reproducible, changes reviewable, and history auditable. Plan output shows exactly what will change—including destructive replacements—before it happens.

**Signals.** Infrastructure changes described as console steps; applies without reviewing plans; environments that differ in unknown ways.

**Ask.** Is this infrastructure change captured in code, and was its plan reviewed for destructive actions?

**Traps.** Applying plans that replace stateful resources; storing state files with secrets unencrypted.

## Containers: small, pinned, non-root, one process {#containers}
<!-- terms: docker dockerfile container containers image layer cache multi-stage base image alpine distroless root user tag latest healthcheck | watch: container-touched -->

**Principle.** Build minimal images with multi-stage builds, pin base images, run as a non-root user, order layers for caching, and give each container one main process.

**Why.** Large images slow deploys and carry vulnerabilities; the latest tag makes builds unreproducible; running as root turns a container escape into host compromise. Ordering layers from least to most frequently changing (dependencies before source) makes rebuilds fast. Health checks let orchestrators restart unhealthy containers.

**Signals.** FROM image:latest; single-stage images containing build tools; containers running as root; COPY . before dependency installation.

**Ask.** Is this image minimal, pinned, non-root and cache-friendly?

**Traps.** Alpine-based images breaking native dependencies; secrets baked into image layers.

## Keep environments alike {#parity}
<!-- terms: environment parity dev staging production config twelve factor same versions local docker compose -->

**Principle.** Development, staging and production should differ only in configuration and scale, not in software versions, services or architecture.

**Why.** Bugs that appear only in production usually come from differences: a different database version, a missing service, a configuration flag, a cache present only in production. Twelve-factor practices—configuration in the environment, backing services as attached resources, identical builds promoted across environments—minimize the gap.

**Signals.** SQLite locally and Postgres in production; features toggled differently per environment without intent; untested production-only configuration.

**Ask.** What differs between the environment where this was tested and production?

**Traps.** Full production replicas for every developer where lighter parity suffices.

## Measure reliability with SLOs {#slo}
<!-- terms: slo sli error budget availability latency reliability monitoring alert pager golden signals -->

**Principle.** Define service level objectives for what users experience—availability and latency of key journeys—and alert on burning error budget, not on every metric.

**Why.** Alerting on CPU spikes and individual errors creates noise that trains people to ignore pages. SLOs connect reliability to user experience and make tradeoffs explicit: while the error budget remains, ship features; when it burns, prioritize reliability. The four golden signals (latency, traffic, errors, saturation) cover most services.

**Signals.** Alerts on internal metrics with no user impact; no definition of acceptable reliability; incidents discovered by users first.

**Ask.** What user-facing objective does this service promise, and would its alerts fire when users are hurt?

**Traps.** SLOs set at 100%, which forbid every change; objectives copied from other companies without matching what users need.

## Deploy small, reversible and observed {#deploys}
<!-- terms: deploy deployment rollout canary blue green feature flag rollback release progressive monitoring -->

**Principle.** Ship small changes frequently with progressive rollout (canaries, feature flags) and a tested, fast rollback, watching metrics as traffic shifts.

**Why.** Large releases bundle many changes, making failures hard to attribute and rollbacks costly. Canary deployments expose a change to a small share of traffic first; feature flags decouple deploying code from releasing features; automated rollback on SLO regressions limits damage. A rollback that has never been exercised is a hope, not a plan.

**Signals.** Infrequent large deployments; no rollback path; deploys without watching error rates; database changes coupled to code releases.

**Ask.** If this deploy misbehaves, how quickly and safely can it be rolled back, and what would reveal the problem?

**Traps.** Feature flags that never get removed; rollbacks blocked by irreversible migrations.

## Incidents: mitigate first, learn blamelessly {#incidents}
<!-- terms: incident outage postmortem root cause mitigation communication status page on call blameless timeline -->

**Principle.** During incidents, restore service first (rollback, failover, disable the feature), communicate status, then investigate; afterward, write a blameless review with concrete follow-ups.

**Why.** Debugging the root cause during an outage extends user impact; mitigation buys time. Clear roles and regular status updates reduce chaos. Blameless postmortems uncover systemic causes—missing tests, unsafe tooling, alert gaps—instead of individual scapegoats, and their action items prevent recurrence.

**Signals.** Live debugging in production during an outage without mitigation; no status communication; postmortems assigning blame.

**Ask.** What is the fastest safe mitigation, and who is communicating status?

**Traps.** Action items that are never tracked to completion.

## Operations has a cost dimension {#cloud-cost}
<!-- terms: cloud cost bill billing instance size autoscaling reserved spot idle storage egress tagging budget -->

**Principle.** Tag resources with owners, set budgets and alerts, right-size and autoscale, and remove idle resources.

**Why.** Cloud bills grow through forgotten resources, oversized instances, unused volumes, verbose logging and data egress. Tags make ownership and cost attribution possible; budgets and alerts catch runaway spend early. Autoscaling matches capacity to demand; spot or preemptible instances cut costs for interruptible work.

**Signals.** Untagged resources; instances sized for peak running at low utilization; experiments left running.

**Ask.** Who owns this resource, what does it cost per month, and is it sized for actual use?

**Traps.** Cost cuts that remove redundancy critical for reliability.
