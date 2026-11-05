# ADR-0007: Outbox publishers claim rows with a lease

## Status
Accepted

## Context
Several publishers run at once. A crash after commit and before publish must be recovered by another instance. Duplicates are acceptable; losses are not.

## Decision
A publisher runs one short transaction: select due rows with `FOR UPDATE SKIP LOCKED`, push `next_attempt_at` forward by the lease, increment `attempts`, commit. It then publishes outside any transaction and marks each row published. If it dies, the lease expires and another instance takes over. Failures back off exponentially with jitter, with no attempt limit. `MessageDeduplicationId` is the `eventId` and `MessageGroupId` the aggregate id.

## The alternative that was rejected
**Holding `FOR UPDATE SKIP LOCKED` while publishing.** It is simpler, with no lease to tune, and a crash releases the lock immediately. But a transaction and a pooled connection stay open across network calls, so a slow broker starves settlement of connections, coupling the two failure domains that the outbox exists to separate.

## Consequences
- A lease shorter than a slow publish causes a duplicate publication, which IR-03 requires consumers to accept.
- Crash recovery is delayed by up to one lease.
- Retries can reorder events in one wallet, so payloads carry `walletVersion`.

## Reopening criterion
Publication latency requirements tighter than polling allows, which would point to `LISTEN/NOTIFY` as a wake-up signal.
