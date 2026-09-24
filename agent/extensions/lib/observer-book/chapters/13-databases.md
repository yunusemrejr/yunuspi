---
id: databases
part: engineering
title: Databases and data modeling
summary: Durable data: schemas and constraints, safe online migrations, indexes that follow queries, transactions and isolation, N+1 access patterns and backups.
terms: database databases sql query queries table tables schema migration migrations index indexes postgres postgresql mysql sqlite mongodb redis orm prisma sequelize django transaction transactions isolation lock deadlock join foreign key constraint backup
files: .sql schema.prisma /migrations/ /migrate/ alembic
tools: sandbox_run
skills: databases sql-query-engineering data-lineage-validation
---

# Databases and data modeling

Databases outlive the applications written against them. Data mistakes are the most expensive mistakes: they cannot be fixed by redeploying, they accumulate silently, and they propagate into reports, backups and downstream systems.

## Enforce invariants in the database {#constraints}
<!-- terms: constraint not null unique foreign key check integrity invariant validation -->

**Principle.** Express integrity rules as database constraints—NOT NULL, UNIQUE, foreign keys, CHECK—not only in application code.

**Why.** Application-level validation is bypassed by scripts, migrations, other services, race conditions and bugs. The database is the last line of defense and the only place where concurrent writers are serialized against the rule. A unique constraint prevents duplicate accounts under a race that application checks cannot; a foreign key prevents orphans that break every later join. Constraints also document the model.

**Signals.** Uniqueness checked with a SELECT before INSERT; nullable columns that are logically required; relations without foreign keys.

**Ask.** Which of this feature's rules would still hold if two requests raced or a script wrote directly to the table?

**Traps.** Constraints that block legitimate migrations; cascading deletes that remove more than intended.

## Migrate online: expand, migrate, contract {#migrations}
<!-- terms: migration migrate alter table add column drop rename backfill lock downtime rollback expand contract | watch: migrations-touched -->

**Principle.** Change schemas in backward-compatible steps: add new structures, backfill and dual-write, switch readers, then remove the old—never rename or drop in one step.

**Why.** During a deploy, old and new application versions run simultaneously; a migration that renames a column breaks whichever version expects the other name. Some operations lock large tables for minutes (adding columns with defaults on older engines, creating indexes without CONCURRENTLY, changing types). Expand-and-contract keeps every step compatible with both versions and makes each reversible. Backfills should run in batches with progress tracking.

**Signals.** Migrations that rename or drop columns used by running code; index creation on large tables without concurrent options; migrations with no down path.

**Ask.** Can the previous application version run correctly against the schema after this migration?

**Traps.** Leaving expand phases forever; testing migrations only on empty databases.

## Indexes follow queries; measure with the query plan {#indexes}
<!-- terms: index indexes explain analyze query plan slow query scan seq scan composite covering -->

**Principle.** Design indexes for the actual query patterns and confirm with EXPLAIN on realistic data volumes.

**Why.** Missing indexes cause full scans that are invisible on small development databases and catastrophic in production. Extra indexes slow every write and consume memory. Composite index column order must match equality-then-range filters and sort order. The query plan on production-like data is the only reliable evidence; intuitions about what the optimizer will do are frequently wrong.

**Signals.** New queries filtering or sorting on unindexed columns; indexes added without checking plans; slow endpoints with database time dominating.

**Ask.** What does the query plan say on production-sized data, and which index does this query use?

**Traps.** Indexing every column; testing plans on tiny tables where scans are optimal.

## Know your isolation level and its anomalies {#transactions}
<!-- terms: transaction isolation read committed repeatable read serializable race lost update lock select for update deadlock -->

**Principle.** Group related writes in transactions, and know which anomalies your isolation level permits—lost updates, write skew, phantom reads.

**Why.** Default isolation (often read committed) allows two transactions to read the same balance and both write a decrement, losing one. Read-modify-write sequences need row locks (SELECT ... FOR UPDATE), atomic updates (SET x = x - 1), optimistic version checks, or serializable isolation with retries. Long transactions hold locks and bloat storage; external calls inside transactions are a classic source of deadlocks and timeouts.

**Signals.** Read-then-write logic outside transactions; counters or balances updated from values read earlier; network calls inside transactions.

**Ask.** If two requests run this code concurrently, can one update be lost?

**Traps.** Serializable everywhere without retry logic; transactions spanning user think-time.

## Kill N+1 and chatty access {#n-plus-one}
<!-- terms: n+1 query loop orm lazy load eager join batch chatty round trip -->

**Principle.** Fetch related data in bulk—joins, IN queries, batching loaders—instead of one query per item.

**Why.** ORMs make it easy to trigger a query inside a loop, turning a page of 100 items into 101 queries. Each round trip adds latency and load; the total dominates response time as data grows. Eager loading, batched loaders (DataLoader pattern) and set-based queries fix it. Query counts per request are an excellent regression test.

**Signals.** Queries inside loops; ORM relation access in templates; response time growing linearly with page size.

**Ask.** How many queries does this request issue for a page of 100 items?

**Traps.** Eager-loading enormous graphs; joins that multiply rows unexpectedly.

## Backups are only real if restores are tested {#backups}
<!-- terms: backup restore disaster recovery point in time dump snapshot retention -->

**Principle.** A backup strategy is defined by a tested restore: how much data can be lost, how long recovery takes, and proof that it works.

**Why.** Backups fail silently: wrong databases dumped, encryption keys lost, retention too short, dumps inconsistent under load. The first real restore attempt, during an incident, is the worst time to discover this. Recovery point and recovery time objectives turn "we have backups" into commitments. Destructive operations (mass deletes, schema drops) should be preceded by a verified backup or be reversible.

**Signals.** Destructive data operations without a fresh backup; backup jobs never restored; manual production data edits.

**Ask.** When was a restore last tested, and is there a backup from before this destructive change?

**Traps.** Backing up to the same failure domain as the primary.
