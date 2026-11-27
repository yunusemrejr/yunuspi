# Migration checklist

Run over a schema or data change before it is written, and again before it runs anywhere real.

## Before writing
- [ ] Engine and version are known. Whether DDL is transactional here is known (PostgreSQL: yes; MySQL: no, each statement commits).
- [ ] Table sizes are known (rows and bytes). Is the system live? If so, old and new code run side by side during rollout, so the change is split: expand, then contract.
- [ ] A backup or snapshot exists before any destructive step (drop, truncate, type change, delete, lossy backfill), its location is recorded, and a restore has worked at least once.
- [ ] Other readers of the schema are listed: reports, exports, replicas, other services, ORM models, fixtures, seeds.

## Writing
- [ ] One purpose per migration. Schema change and data backfill are separate steps.
- [ ] Safe to rerun: existence checks (`IF NOT EXISTS`) or a migration tool that records applied versions, and a rerun after a partial failure works.
- [ ] Reversible, or marked fix-forward with the reason. A tested down step exists wherever data would be lost.
- [ ] A shipped migration is never edited; a new one corrects it.
- [ ] New required column: add it nullable (or with a default), backfill, then enforce `NOT NULL`. Check how this engine handles a default on a large table.
- [ ] A rename is add new, write both, backfill, switch reads, then drop old, never a bare `RENAME` on a live system.
- [ ] Dropping a column or table comes last, in a later release, after no code reads or writes it.
- [ ] Large index builds use the engine's online option (PostgreSQL: `CREATE INDEX CONCURRENTLY`, outside a transaction block).
- [ ] New foreign keys and check constraints on big tables are added without a long lock (PostgreSQL: `NOT VALID`, then `VALIDATE CONSTRAINT`).
- [ ] DDL has a lock timeout so a waiting `ALTER` cannot block all traffic behind it.
- [ ] Type changes are checked for loss: truncation, precision, time zone, encoding.

## Backfill
- [ ] Chunked by key range, one transaction per chunk, with a pause between chunks and a throttle on replica lag.
- [ ] Idempotent and resumable from a recorded position; progress is logged.
- [ ] Never holds one long transaction or one long lock.

## Verify
- [ ] Run first on a copy with production-sized data; duration and locks observed.
- [ ] Counts and checksums or aggregates match before and after; no `NULL` left in a column now required; a query for constraint violations returns nothing.
- [ ] Order of release is right: expand migrations before the code that uses them, contract migrations after the code stopped using the old shape.
- [ ] Application code works against both the old and the new schema during the rollout.

## Run and roll back
- [ ] The rollback is written before the run: what to execute, what data would be lost, how long it takes, and what condition stops the run.
- [ ] A production run happens only when the task authorizes it. What ran and its result are recorded.
- [ ] The backup stays until the contract step is verified, then the stale copy is deleted.
