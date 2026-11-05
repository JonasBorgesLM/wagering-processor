# ADR-0001: One deployable, with processes selected by role

## Status
Accepted

## Context
The system has four kinds of work: HTTP, queue consumption, outbox publishing and pending-reference retries. The challenge requires atomicity across wallet, ledger, inbox and outbox, three or more running instances, and "simplicity" in its scoring.

## Decision
A single modular NestJS application and image. `APP_ROLES` picks which work an instance runs; by default it runs everything. There is one bounded context, `wagering`, holding `Wallet` and `WagerTransaction`, with layers `domain`, `application` and `infrastructure`.

## The alternative that was rejected
**Separate wallet and wagering services.** It buys independent deployment and team ownership. Both change inside one SQL transaction, so splitting them means a distributed transaction or a saga where the requirement is plain atomicity, and turns a commit into an eventual consistency problem. There is no second team to justify that.

**CQRS, Event Sourcing, a command bus.** Event Sourcing conflicts with a required materialized balance; reads are simple queries with no separate model to justify CQRS; a bus adds a hop between controller and use case while the use case has exactly one caller shape.

## Consequences
- Roles scale separately, and the multi-instance tests can run the real thing.
- All roles share a release, so a bad deploy affects all work at once.
- Two aggregates change in one transaction, against the usual DDD guideline. This is deliberate: the challenge requires that atomicity.

## Reopening criterion
A role needing a different scaling or release cadence than the others, measured in production.
