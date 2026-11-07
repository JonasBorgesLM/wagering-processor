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

## Amendment: what the load test showed

`bun run test:load` ([`docs/LOAD-TEST.md`](../LOAD-TEST.md)): three publishers emptied a backlog at 125 to 138 events per second in total, while settlement produced about 900 per second at the spread rate, so under sustained load above roughly 65 bets per second the lag grows without bound. The decision (a lease, no transaction held while publishing) was not at fault and no event was lost or published twice by it; the limit is that each publisher sends one message at a time. The reopening criterion names latency requirements tighter than polling allows; this is a different one, **throughput**, and it is open. Sending ten per call and different wallets in parallel would keep each wallet's order.

## Amendment: batched sends (issue #51)

The decision stands: a lease, no transaction held while publishing. What changed is how a claimed round is sent: ten to a call with `SendMessageBatch`, over lanes that keep each wallet's events together and in order, with marking and rescheduling as one statement each (REQUIREMENTS FR-96). Measured on the local emulator, which handles requests one after another, it lifted a publisher alone from 137 to 185 events per second with one lane and to 230 to 300 with four to eight; more lanes cost settlement latency in the full load test, so the default is one ([`docs/LOAD-TEST.md`](../LOAD-TEST.md)). Publication throughput is still below settlement there, and the reopening criterion above (throughput) stays open until it is measured against real SQS.
