# ADR-0010: HTTP submissions settle synchronously

## Status
Accepted

## Context
Transactions enter by HTTP and SQS. HTTP could enqueue everything and answer `202`, unifying both paths. The challenge's sample response returns `PROCESSED` with a balance.

## Decision
Both entries call the same use case directly, and it commits before responding or acknowledging. `202` means a missing reference only.

## The alternative that was rejected
**Enqueue from HTTP.** It smooths bursts and gives one write path. But the response could never carry the result the contract shows, and providers would poll for every operation.

## Consequences
- HTTP latency includes lock waits, and a burst on one wallet produces `503` with `Retry-After`.
- `PENDING` is an in-memory birth state in practice (FR-31).

## Reopening criterion
A provider contract accepting asynchronous results for every operation.
