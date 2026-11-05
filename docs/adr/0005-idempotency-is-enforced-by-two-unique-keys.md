# ADR-0005: Idempotency rests on two unique keys and a stored result

## Status
Accepted

## Context
The header is the source of truth for idempotency, but references and lookups use `(providerId, externalTransactionId)`. A replay must return the original balance, while `LOSS` and `REJECTED` have no ledger entry to read it from. SQS adds a third identity, `messageId`.

## Decision
- `UNIQUE (idempotency_key)` and `UNIQUE (provider_id, external_transaction_id)` on the transaction.
- The result lives on the row: status, `failure_code`, and the balance observed at decision.
- The hash covers business fields only (FR-51), so a replay matches between HTTP and SQS.
- The inbox is separate, keyed `(consumer_name, message_id)`: it answers "did this consumer handle this delivery", while the key answers "did this operation happen".
- A unique violation from a race restarts the flow once, which then finds the winner's row.

## The alternative that was rejected
**A separate idempotency table storing the serialized response.** It works for any endpoint and replays byte-identical bodies. It duplicates what the transaction row already holds, and adds a second row that must stay consistent with it.

## Consequences
- A `REJECTED` result is final for that key (FR-57), so a retry after funding needs a new id.
- Conflicts store no row, because the payload that conflicted is not an operation. Over HTTP the caller is told; over SQS the message goes to the DLQ.

## Reopening criterion
Idempotency being required on endpoints other than transaction submission.
