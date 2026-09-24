---
id: dataops
part: operations
title: DataOps and data engineering
summary: Reliable data pipelines: idempotent reruns and backfills, schemas and data contracts, quality checks at boundaries, lineage, incremental processing and late data, orchestration, and privacy in data flows.
terms: data pipeline pipelines etl elt dataops data engineering warehouse lake lakehouse dbt airflow dagster prefect spark kafka batch streaming ingestion transform backfill schema evolution data contract data quality lineage partition parquet csv incremental late arriving deduplicate dedupe
files: .sql .py .yml dbt_project.yml /dags/ /pipelines/ .parquet .csv
tools: sandbox_run math_check
skills: data-lineage-validation databases sql-query-engineering statistical-experiments
---

# DataOps and data engineering

Data pipelines fail quietly. A broken web service returns errors; a broken pipeline produces plausible wrong numbers that flow into dashboards, models and decisions. DataOps applies software engineering discipline—tests, contracts, observability, reproducibility—to data.

## Make every run idempotent {#idempotent}
<!-- terms: idempotent rerun backfill overwrite partition upsert duplicate duplicates dedupe deduplicate daily append replay -->

**Principle.** Design pipeline steps so running them twice for the same input produces the same result—overwrite partitions or upsert by key rather than blindly appending.

**Why.** Pipelines are rerun constantly: after failures, for backfills, after logic fixes. Append-only steps duplicate data on every rerun, silently inflating metrics. Partition overwrites and keyed merges make reruns safe, which makes recovery routine instead of risky.

**Signals.** INSERT or append steps without deduplication; backfills that require manual cleanup; metrics jumping after reruns.

**Ask.** What happens to the output if this step runs twice for the same period?

**Traps.** Overwriting partitions that other jobs also write to.

## Contracts at the boundaries {#contracts}
<!-- terms: data contract schema evolution breaking column rename type change producer consumer upstream -->

**Principle.** Agree on schemas, semantics and freshness with upstream producers, validate incoming data against them, and evolve schemas compatibly.

**Why.** Most pipeline breakages come from upstream changes nobody announced: a renamed column, a new enum value, a unit change from seconds to milliseconds. Data contracts make expectations explicit and testable at ingestion, so violations fail loudly at the boundary rather than corrupting downstream tables. Additive changes are safe; renames and type changes need coordination.

**Signals.** Ingestion that accepts any schema; downstream failures traced to upstream changes; undocumented column meanings.

**Ask.** What schema and meaning does this pipeline assume from its source, and what checks enforce it?

**Traps.** Contracts so rigid that harmless additions break ingestion.

## Test data, not just code {#quality}
<!-- terms: data quality tests null unique accepted values referential freshness volume anomaly great expectations dbt tests -->

**Principle.** Assert data quality at each stage: uniqueness, non-null keys, accepted values, referential integrity, freshness and expected volume.

**Why.** Code tests prove logic on fixtures; data tests prove today's actual data is sane. Volume anomalies catch partial loads; freshness checks catch stalled sources; uniqueness catches join explosions. Failing fast on bad data prevents it from propagating into reports that people act on.

**Signals.** Pipelines with no data assertions; joins that could multiply rows; dashboards discovered wrong by users.

**Ask.** Which checks would catch a partial load, a duplicated join or a stalled source here?

**Traps.** So many noisy checks that failures are ignored.

## Know where every number comes from {#lineage}
<!-- terms: lineage provenance source upstream downstream dependency impact analysis metric definition -->

**Principle.** Maintain lineage from sources to reports, and define metrics once in a shared layer rather than re-deriving them in each dashboard.

**Why.** When a number looks wrong, lineage answers where it came from and what else is affected. Metrics defined separately in many dashboards drift until "revenue" has five values. A semantic or metrics layer with single definitions, plus lineage graphs, makes numbers trustworthy and changes impact-assessable.

**Signals.** The same metric computed differently in several places; no way to trace a report column to its source.

**Ask.** Can this number be traced to its sources, and is its definition shared with other reports?

**Traps.** Lineage tooling nobody maintains.

## Handle late and out-of-order data {#late-data}
<!-- terms: late arriving data out of order event time processing time watermark window incremental reprocess -->

**Principle.** Distinguish event time from processing time, and design incremental loads with lookback windows or watermarks for late data.

**Why.** Events arrive late from mobile devices, retries and batch exports. Incremental jobs that process only "new since last run" by processing time miss late events forever; windows that close too early produce wrong aggregates. Lookback windows that reprocess recent partitions and watermarks that bound lateness give correct results at bounded cost.

**Signals.** Incremental logic keyed on load time; daily aggregates that never change after the first run despite late data.

**Ask.** What happens to an event that arrives two days late?

**Traps.** Unbounded reprocessing windows making jobs slow and expensive.

## Orchestrate with explicit dependencies and retries {#orchestration}
<!-- terms: orchestration dag airflow dagster schedule dependency retry sla backoff sensor trigger -->

**Principle.** Express pipelines as DAGs with explicit dependencies, idempotent tasks, bounded retries and alerting on failures and lateness.

**Why.** Cron-scheduled scripts that assume upstream jobs finished on time fail silently when they have not. Orchestrators make dependencies explicit, retry transient failures, and surface lateness. Combined with idempotent tasks, they make recovery a button press.

**Signals.** Pipelines chained by schedule timing instead of dependencies; failures noticed only by consumers.

**Ask.** If an upstream job is late or fails, does this pipeline wait, retry or alert?

**Traps.** Retrying non-idempotent tasks.

## Personal data needs a purpose and an expiry {#privacy}
<!-- terms: pii personal data privacy gdpr retention anonymize pseudonymize mask access delete consent -->

**Principle.** Collect and move personal data only for a stated purpose, minimize and mask it in analytics, restrict access, and enforce retention and deletion.

**Why.** Data pipelines copy personal data into many places—warehouses, extracts, notebooks, logs—each a breach and compliance risk. Pseudonymizing identifiers, dropping unneeded fields at ingestion and propagating deletion requests downstream reduce exposure. Regulations require knowing where personal data lives.

**Signals.** Raw personal data copied into analytics tables; extracts with emails and addresses in shared locations; no retention policy.

**Ask.** Does this pipeline need the personal fields it moves, and how would a deletion request reach every copy?

**Traps.** Assuming hashing an email makes it anonymous.
