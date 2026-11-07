# ADR-0003: Concurrency uses a wallet row lock, taken before any insert

## Status
Accepted

## Context
The concurrency unit is `walletId`. The challenge allows pessimistic locking, optimistic retry, conditional updates or a mix, and forbids a global lock.

Settlement needs more than a balance decrement: it reads the reference, checks whether it was reversed, and decides. All of that must be consistent with the balance.

## Decision
Every settlement runs under `SELECT ... FOR UPDATE` on the wallet row, with a `lock_timeout` that maps to a transient failure. **The lock is taken before any row referencing the wallet is inserted.** Order: inbox insert, wallet lock, idempotency re-check, reference resolution, decision, writes, commit.

The order is the requirement. An insert with a foreign key holds `FOR KEY SHARE` on the wallet, so two transactions that insert first and lock second wait on each other. `test/integration/database-runtime.test.ts` reproduces that deadlock and shows the chosen order avoiding it.

A lock-free read returns replays of terminal transactions before queueing, so duplicates do not contend. Schema constraints stay as the last line in case the code is wrong.

## The alternative that was rejected
**Optimistic locking with retry.** It holds no lock across the decision, and suits low contention. A hot wallet is exactly the case the challenge scores: retries there burn work, need a bound, and the bound turns contention into failures. It also needs the reversal check to be re-validated on each attempt.

**A conditional update alone** (`UPDATE ... WHERE balance >= x`). This is excellent for a plain debit, but reversals and reference checks do not fit in one statement.

**Using `FOR NO KEY UPDATE` and inserting first.** It avoids the deadlock too, but MikroORM's `LockMode` does not offer it directly, and it would let duplicates queue behind inserts in a less obvious order.

## Consequences
- Operations on one wallet are strictly serial, so throughput per wallet is bounded by settlement time. That is accepted, and the load test measures it.
- No network call may happen inside the transaction.
- Waiting requests hold pool connections, which is the main limit under a burst (T-11).

## Reopening criterion
Load tests showing a realistic hot wallet exhausting the pool at a rate the provider contract requires.

## Amendment: what the load test showed

`bun run test:load` ([`docs/LOAD-TEST.md`](../LOAD-TEST.md), three 20-second runs on one laptop): one wallet settles about 145 bets per second, in a row, about 7 ms each; with 64 callers on it the slowest answer was 1.8 s against the 2 s lock timeout, and with 256 callers 3.1 % of answers were `503` from the pool, with no lock timeout. The reopening criterion needs a rate the provider contract requires, and the challenge gives none, so it is **not met and cannot be decided**: nothing here shows a realistic hot wallet failing. The margin of the lock timeout is small.
