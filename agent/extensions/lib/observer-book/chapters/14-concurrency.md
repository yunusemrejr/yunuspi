---
id: concurrency
part: engineering
title: Concurrency and distributed systems
summary: Correctness when things happen at once or far apart: ownership of shared state, cancellation, ordering and delivery guarantees, deadlines, consistency and backpressure.
terms: concurrency concurrent parallel parallelism thread threads lock mutex race condition deadlock async worker queue message broker kafka rabbitmq distributed consensus consistency eventual replication partition idempotent retry ordering exactly once at least once backpressure
tools: bg_run sandbox_run
skills: concurrency-memory-models distributed-systems formal-model-checking
---

# Concurrency and distributed systems

Concurrency bugs are rare per execution and certain over enough executions. Distributed systems add partial failure: any message may be lost, delayed, duplicated or reordered, and any node may pause at any time. The doctrine is to design for these facts rather than hope around them.

## Shared mutable state needs one owner {#ownership}
<!-- terms: shared state mutable lock mutex race condition thread safe atomic actor channel -->

**Principle.** Either give mutable state a single owner that serializes access (an actor, a channel, a lock) or make it immutable; unsynchronized sharing is a bug waiting for load.

**Why.** Races arise when two executions read-modify-write the same data without coordination. Locks work but compose poorly (deadlocks, contention); message passing to an owner keeps invariants in one place; immutability removes the problem. Even single-threaded async code races across await points: state checked before an await may be different after it.

**Signals.** Global mutable maps accessed from handlers; check-then-act across await points; locks acquired in different orders in different places.

**Ask.** Who owns this state, and can two executions interleave between reading and writing it?

**Traps.** Coarse locks around slow I/O; believing single-threaded runtimes cannot race.

## Cancellation and cleanup on every path {#cancellation}
<!-- terms: cancel cancellation abort signal cleanup finally dispose resource leak timeout shutdown graceful -->

**Principle.** Every long-running operation must be cancellable, and cleanup must run on success, failure and cancellation alike.

**Why.** Operations that ignore cancellation keep consuming resources after their result is irrelevant, and on shutdown they block or leave partial state. Cleanup placed only on the success path leaks file handles, locks, temp files and child processes on the failure paths, which are exactly the paths under stress. Structured concurrency—child tasks bounded by their parent's lifetime—makes this systematic.

**Signals.** Loops or workers that never check an abort signal; cleanup missing from error paths; orphaned processes after interruption.

**Ask.** If this operation is cancelled or fails halfway, what is left running or half-written?

**Traps.** Swallowing cancellation errors as generic failures; cleanup code that can itself hang.

## Assume at-least-once delivery {#delivery}
<!-- terms: exactly once at least once duplicate idempotent message queue retry dedupe ordering outbox -->

**Principle.** Design consumers to be idempotent and deduplicate by message id; "exactly once" is achieved end-to-end by idempotence, not by the transport.

**Why.** Brokers redeliver after consumer crashes, producers retry after ambiguous timeouts, and webhooks resend. Processing a payment message twice is a real outcome of normal failure handling. Idempotent handlers (upserts keyed by message id, processed-id tables, natural idempotence) make duplicates harmless. The transactional outbox pattern keeps database writes and message publication consistent without distributed transactions.

**Signals.** Consumers that insert or charge on every message; database commit and message publish as separate unprotected steps.

**Ask.** What happens if this message is delivered twice, or published but the database write rolled back?

**Traps.** Relying on broker "exactly-once" features across system boundaries they do not cover.

## Ordering is a guarantee you must pay for {#ordering}
<!-- terms: order ordering sequence out of order partition key clock timestamp causal version -->

**Principle.** Do not assume messages or events arrive in the order they were produced unless the system guarantees it for that key; use versions or sequence numbers to reject stale updates.

**Why.** Parallel consumers, retries and multiple partitions reorder events. Wall-clock timestamps from different machines cannot establish order reliably. Last-write-wins with skewed clocks silently discards newer data. Per-entity ordering (partition by key), monotonic versions with compare-and-set, or CRDTs for mergeable data provide correct outcomes under reordering.

**Signals.** State updates applied without version checks; ordering inferred from timestamps across hosts; parallel consumers on order-sensitive streams.

**Ask.** If an older update arrives after a newer one, what prevents it from overwriting the newer state?

**Traps.** Global ordering requirements that serialize a whole system for one entity's needs.

## Deadlines propagate {#deadlines}
<!-- terms: deadline timeout budget propagate cascade retry storm latency slow dependency -->

**Principle.** A request's remaining time budget should travel with it; downstream calls must finish within what is left, not their own generous defaults.

**Why.** If the user's request times out at 10 seconds but internal calls each allow 30, work continues long after anyone is waiting, consuming capacity during exactly the overload that caused the timeout. Propagated deadlines (context deadlines, gRPC deadlines, explicit budget headers) let every layer give up in time. Retries must fit inside the remaining budget.

**Signals.** Nested timeouts longer than the outer one; retries that ignore elapsed time; work continuing after client disconnect.

**Ask.** How much of the caller's time budget remains when this call starts, and does the call respect it?

**Traps.** Deadlines so tight that normal variance causes failures.

## Bounded queues and backpressure {#backpressure}
<!-- terms: backpressure queue bounded unbounded buffer overflow memory producer consumer rate limit load shedding -->

**Principle.** Every queue and buffer needs a bound and a policy when full: block the producer, drop, or shed load—explicitly.

**Why.** Unbounded queues convert overload into memory exhaustion and multi-minute latency; everything looks fine until it falls over. Bounded queues surface overload immediately and let the system choose what to sacrifice. Load shedding (rejecting early with 429/503) keeps the system responsive for the traffic it can serve. Little's law (items = arrival rate × time in system) quickly estimates queue sizes.

**Signals.** In-memory arrays used as unbounded job queues; producers faster than consumers with no feedback; memory growth under load.

**Ask.** What happens when producers outpace consumers here for an hour?

**Traps.** Bounds so small they reject normal bursts; dropping data that must not be lost without telling anyone.

## Choose consistency deliberately {#consistency}
<!-- terms: consistency eventual strong linearizable cap partition replication read your writes cache stale -->

**Principle.** Decide per operation which consistency the user needs—read-your-writes, monotonic reads, strong—and pay for coordination only there.

**Why.** Strong consistency across regions costs latency and availability; eventual consistency is cheap but surprises users who do not see their own changes. Most products need strong consistency for money and permissions, read-your-writes for user edits, and eventual consistency for feeds and analytics. Making the choice explicit prevents both over-engineering and baffling "my change disappeared" bugs.

**Signals.** Reads from replicas immediately after writes; caches serving stale permission data; cross-region writes without conflict strategy.

**Ask.** What does the user expect to see immediately after this write, and does the read path guarantee it?

**Traps.** Distributed transactions where a simpler ownership boundary would avoid them.
