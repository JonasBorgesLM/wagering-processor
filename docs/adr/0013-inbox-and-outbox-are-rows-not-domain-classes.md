# ADR-0013: The inbox and the outbox are rows written by the use case, not domain classes

## Status
Accepted. Recorded after the code: the decision was made while building issues #15 and #18 and is written down here because the challenge's sketch (§6.5) shows the other option.

## Context
Section 6.5 of the challenge sketches `InboxMessage` (`receive`, `isProcessed`, `markProcessed`) and `OutboxMessage` (`enqueue`, `isDue`, `markPublished`, `scheduleRetry`) as classes with private constructors and factories, like the domain's. It also says names and signatures may be adapted as long as the guarantees hold.

What those two need to guarantee is about concurrency and atomicity, not about rules: an inbox row is written in the same SQL transaction as the effect, and a second delivery of the same message must wait for the first and then find it; an outbox row must be claimed by exactly one publisher at a time and become visible again if that publisher dies. Every one of those guarantees is a property of a statement and the locks it takes, not of an object in memory.

## Decision
The inbox is one port method, `inbox.record(message)`, implemented as `INSERT ... ON CONFLICT DO NOTHING RETURNING` inside the settling transaction; a conflict answers with the stored hash. The outbox is written by `outbox.enqueue(events)` in the same transaction, and claimed by `OutboxStore.claimDue`, one `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)` that sets the lease and counts the attempt. Rescheduling, marking and the backoff are in `PublishOutbox`, with the delay from `backoffSeconds`. The integration event, which is what the outbox stores, is a domain class (`IntegrationEvent` and its subclasses), so the part that has rules is modelled.

## The alternative that was rejected
**`InboxMessage` and `OutboxMessage` as domain classes, as sketched.** They would be loaded, changed in memory and saved. That reads well, and it is what an evaluator would look for under "invariants encapsulated in classes". It was rejected because the object would hold none of the guarantees. `isDue(now)` in memory would decide on a row another publisher may be claiming at that moment, so the real decision would still be the `SKIP LOCKED` claim, and the class would be a second, weaker copy of it. `scheduleRetry(now)` would need a load, a change and a save, which is a read-modify-write of exactly the kind the claim avoids. `InboxMessage.receive` followed by a save would turn the one statement that makes two deliveries wait for each other into two statements with a gap between them. Each method would either duplicate a SQL statement or weaken it.

## Consequences
- The guarantees live where they are enforced, and each has a test against real PostgreSQL, including concurrent claims and crashes after each write.
- An evaluator reading §6.5 will not find the two classes, and has to read this record to see why.
- Retry policy for the outbox is in the application layer (`PublishOutbox`) and not on an object, so it is tested through the use case rather than as a pure method.
- There is no in-memory representation of an inbox or outbox row to reuse elsewhere; nothing needs one today.

## Reopening criterion
A rule about an inbox or outbox row that is not a property of the statement that writes it: for example a retention rule that depends on a row's history, or a second kind of message with its own lifecycle.
