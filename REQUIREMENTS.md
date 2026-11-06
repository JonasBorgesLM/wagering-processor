# wagering-processor — Requirements

**Version:** 0.1 (draft for review)
**Status:** baseline for implementation — no code written yet
**Source:** [`junglegaming/backend-challenge`](https://github.com/junglegaming/backend-challenge) at `c7143e6`. `§n` cites a section of that README.

A requirement without a test that fails when the protection is removed counts
as unimplemented. Interpretations (`INT-nn`) are decisions the README leaves
open; §7 of the README requires them to be documented.

---

## 1. Purpose

A distributed financial service that applies wagering operations from multiple
game providers to player wallets, and stays correct when messages are
duplicated, delivered out of order, processed simultaneously, or interrupted by
a crash.

**Global invariants (§3):** no duplicate credit, no duplicate debit, no lost
confirmed event, no negative balance. At the end of every test:
`wallet.balance == balance rebuilt from the ledger` (§13).

### 1.1 Non-goals

- Rounds are not a state machine. The provider owns round lifecycle (`INT-07`).
- Partial reversals (§7.5).
- Authentication: documented extension point only, no scored value (§2, §14).
- Correcting divergences automatically (§9).

---

## 2. Actors

| Actor | Role | Assumed capability | Assumed *not* to have |
| --- | --- | --- | --- |
| Game provider | Submits operations over HTTP or SQS | Retries; sends duplicates and out-of-order operations | Ability to submit `OPENING`; a correct view of ordering |
| Queue (SQS) | Trusted internal channel (§2) | At-least-once delivery | Authority over identity: domain validation still applies |
| Event consumer | Reads integration events | Deduplicates by `eventId` | An exactly-once or strictly ordered feed |
| Operator | Handles DLQ, reconciliation alerts | Reads logs and metrics | Permission to edit the ledger |

---

## 3. Functional requirements

### 3.1 Money (§6.1)

- **FR-01** Contract amounts match `^(0|[1-9][0-9]*)\.[0-9]{2}$`. `NaN`, `Infinity`, scientific notation, empty strings, negative values and any other scale are rejected. `"25"` and `"25.5"` are invalid (`INT-01`).
- **FR-02** `Money` never rounds. Arithmetic is exact and immutable; no `number` holds a monetary value at any layer.
- **FR-03** Operations across currencies raise a domain error. The model is multi-currency; only `BRL` needs to be exercised beyond conflict tests.
- **FR-04** `Money` can be negative internally (`negate`, signed reconciliation `difference`). Only input contracts reject negatives (`INT-02`).
- **FR-05** Contract amounts are capped so that no accepted value can overflow the database column (`INT-03`).

### 3.2 Wallet (§6.2, §9)

- **FR-10** At most one wallet per `playerId` + `currency`; a duplicate is a conflict.
- **FR-11** A positive `initialBalance` creates an `OPENING` transaction and a `CREDIT` ledger entry in the same SQL transaction. The wallet starts at `version = 1`.
- **FR-12** A zero `initialBalance` creates neither transaction nor ledger entry, and also starts at `version = 1`.
- **FR-13** `version` increments only when the balance changes: never on `LOSS`, rejection, pending, or replay.
- **FR-14** Every balance change has exactly one ledger entry, and every ledger entry corresponds to one balance change.
- **FR-15** Each ledger entry records the `walletVersion` it produced, strictly increasing per wallet. The opening entry carries version 1, because opening sets the first state rather than changing it (FR-13). A wallet opened at zero has no entry for version 1.

### 3.3 Operations (§7)

| Kind | Balance | Ledger | Reference | Amount |
| --- | --- | --- | --- | --- |
| `BET` | debit | 1 `DEBIT` | none | > 0 |
| `WIN` | credit | 1 `CREDIT` | optional, must be a `BET` | > 0, any value |
| `LOSS` | none | none | optional, must be a `BET` (`INT-04`) | >= 0 (`INT-05`) |
| `REFUND` | credit | 1 `CREDIT` | required, must be a `BET` | equals reference |
| `ROLLBACK` of `BET` | credit | 1 `CREDIT` | required | equals reference |
| `ROLLBACK` of `WIN` or `REFUND` | debit | 1 `DEBIT` | required | equals reference |
| `OPENING` | credit | 1 `CREDIT` | internal only, cannot be submitted or referenced | > 0 |

- **FR-20** `ROLLBACK` cannot reference `LOSS`, `OPENING` or another `ROLLBACK` (§7.3).
- **FR-21** A reference resolves by `(providerId, referenceExternalTransactionId)` and must share player, wallet, currency and round (§7.2).
- **FR-22** A reference can be reversed once, by any reversal kind. Full definition in section 3.3.1 below (`INT-06`).
- **FR-23** A round can hold several `BET` and `WIN` operations; only `externalTransactionId` is unique (`INT-08`).
- **FR-24** A `WIN` referencing an already reversed `BET` is rejected (`INT-09`).
- **FR-25** `REJECTED` never changes the balance and never creates a ledger entry (§7.6).

### 3.3.1 REFUND and ROLLBACK

| | `REFUND` | `ROLLBACK` |
| --- | --- | --- |
| Meaning in the README | Reverts a `PROCESSED` `BET`, once | Reverts a `PROCESSED` transaction, once, with the inverse effect |
| Allowed reference | `BET` | `BET`, `WIN` or `REFUND` |
| Effect | Always `CREDIT` | Inverse of the reference: `BET` gives `CREDIT`; `WIN` or `REFUND` gives `DEBIT` |
| Can fail for lack of funds | No | Only when reversing `WIN` or `REFUND` |
| Reference id | Required | Required |
| Amount | Equal to the reference | Equal to the reference |

The README does not explain the business difference beyond this table, so no
further meaning is assumed.

**Decision, confirmed by the project owner on 2026-11-05:** a reference accepts **one `PROCESSED` reversal in total**, whether `REFUND` or `ROLLBACK`. The challenge's rule 7.4 only forbids repeating the same type, but it does not permit mixing types, and allowing the mix would create money:

```text
BET 80 → -80 | REFUND → +80 | ROLLBACK of the same BET → +80 = 80 created from nothing
```

So once a `BET` is refunded it cannot also be rolled back, and the reverse, even though a literal reading of rule 7.4 alone might suggest otherwise. Reasoning and rejected options: [ADR-0006](docs/adr/0006-one-processed-reversal-per-reference.md).

- **FR-26** A reference must have the same provider, player, wallet, currency and round. Lookup is scoped to the provider, so another provider's transaction is simply not found: it waits and expires as `REFERENCE_NOT_FOUND`.
- **FR-27** Only a `PROCESSED` reversal uses up the reference. A `REJECTED` or `PENDING_REFERENCE` reversal does not, so a `ROLLBACK` refused for lack of funds can be sent again under a new `externalTransactionId`.
- **FR-28** Reversals are not cascading: reversing a `BET` leaves its `WIN` in place, and rolling back a `REFUND` does not restore the `BET` as reversible.
- **FR-29** Concurrent or duplicate-reference reversals settle under the wallet lock: the first applies, the others get `ALREADY_REVERSED`, and the database index is the final guard.

Starting from a balance of `100.00`, each line continuing from the previous:

| Operation | Result | Balance |
| --- | --- | --- |
| `BET` b1 `80.00` | `PROCESSED` | `20.00` |
| `REFUND` r1 of b1, `50.00` | `REJECTED`, `REFERENCE_AMOUNT_MISMATCH` | `20.00` |
| `REFUND` r2 of b1, `80.00` | `PROCESSED` | `100.00` |
| `REFUND` r3 of b1, `80.00` | `REJECTED`, `ALREADY_REVERSED` | `100.00` |
| `ROLLBACK` x1 of b1, `80.00` | `REJECTED`, `ALREADY_REVERSED` | `100.00` |
| `REFUND` r2 again, same key | Replay of the original result | `100.00` |
| `ROLLBACK` x2 of r2, `80.00` | `PROCESSED`, debit | `20.00` |
| `ROLLBACK` x3 of x2 | `REJECTED`, `REFERENCE_KIND_NOT_ALLOWED` | `20.00` |
| `WIN` w1 `500.00` of b1 | `REJECTED`, `ALREADY_REVERSED` (`INT-09`) | `20.00` |
| `WIN` w2 `500.00`, no reference | `PROCESSED` | `520.00` |
| Player spends: `BET` b2 `510.00` | `PROCESSED` | `10.00` |
| `ROLLBACK` x4 of w2, `500.00` | `REJECTED`, `REVERSAL_INSUFFICIENT_FUNDS` | `10.00` |
| `LOSS` l1 of b2, `0.00` | `PROCESSED`, no ledger entry, version unchanged | `10.00` |
| `ROLLBACK` x5 of a `LOSS` | `REJECTED`, `REFERENCE_KIND_NOT_ALLOWED` | `10.00` |
| `REFUND` r4 of w2 | `REJECTED`, `REFERENCE_KIND_NOT_ALLOWED` | `10.00` |
| `ROLLBACK` x6 of a transaction not yet arrived | `PENDING_REFERENCE` | `10.00` |

A provider cannot reverse an `OPENING`: it belongs to the internal provider, and a reference is looked up within the sender's own provider, so it is never found. The transaction waits and expires as `REFERENCE_NOT_FOUND` (FR-20, FR-26). Handed one directly, the policy refuses it as `REFERENCE_MISMATCH`, because its provider and round never match.

### 3.4 Status lifecycle (§6.3)

```text
PENDING ──▶ PROCESSED | REJECTED | PENDING_REFERENCE | FAILED
PENDING_REFERENCE ──▶ PROCESSED | REJECTED | FAILED
```

- **FR-30** `PROCESSED`, `REJECTED` and `FAILED` are terminal. Transitioning out of them is a programming error, not a business path. A trigger also refuses updating or deleting such a row, so the rule and the audit trail hold if the code is wrong.
- **FR-31** `PENDING` is the in-memory birth state; the first commit stores its outcome, because HTTP and SQS settle synchronously (`INT-10`).
- **FR-32** `FAILED` is set only by the pending-reference worker, for a stored transaction that cannot be settled for non-business reasons after its attempts run out. Failures with no stored row go to retry or DLQ (`INT-11`). It carries `SETTLEMENT_FAILED`, never a business code, because a rejection blames the payload and an infrastructure fault must not (`INT-20`).

### 3.5 Settlement order

Checks run under the wallet lock, in this order, so the same input always gets the same code:

1. Wallet exists, otherwise `WALLET_NOT_FOUND` (nothing stored, `INT-12`).
2. Idempotency: replay or conflict (section 3.7 below).
3. Player matches the wallet: `PLAYER_WALLET_MISMATCH`.
4. Currency matches the wallet: `CURRENCY_MISMATCH`.
5. No reference given: go to step 11.
6. Reference not found: `PENDING_REFERENCE`.
7. Player, wallet, currency or round differ: `REFERENCE_MISMATCH`.
8. Reference kind not allowed: `REFERENCE_KIND_NOT_ALLOWED`.
9. Reference `PENDING` or `PENDING_REFERENCE`: stay pending. Reference `REJECTED` or `FAILED`: `REFERENCE_NOT_PROCESSED`.
10. Reversal amount differs: `REFERENCE_AMOUNT_MISMATCH`. Already reversed: `ALREADY_REVERSED`.
11. Debit without funds: `INSUFFICIENT_FUNDS` for `BET`, `REVERSAL_INSUFFICIENT_FUNDS` for `ROLLBACK` (§7.9). Credit above the column limit: `BALANCE_LIMIT_EXCEEDED`.
12. Apply: update wallet, append ledger, mark `PROCESSED`.

### 3.6 Out-of-order references (§7.1)

- **FR-40** A scheduled worker retries `PENDING_REFERENCE` with exponential backoff, re-running the settlement order of section 3.5 under the wallet lock.
- **FR-41** Default backoff starts at 5s, doubles, and caps at 5 min. TTL is 1 h and configurable. One hour outlasts ordinary provider and queue redelivery without leaving a reversal open for a whole gaming session (`INT-13`).
- **FR-42** On expiry the transaction becomes `REJECTED` with `REFERENCE_NOT_FOUND`, and `WagerTransactionRejected` is published.
- **FR-43** Balance is checked at settlement, not at arrival.

**Known limitation:** a `BET` arriving after its `ROLLBACK` expired is applied normally. There is no tombstone, because the README specifies waiting and then rejecting. The provider must issue a new reversal under a new id.

### 3.7 Idempotency (§9, §7.7)

- **FR-50** `Idempotency-Key` is mandatory over HTTP; over SQS it is `data.idempotencyKey`. Both feed the same use case.
- **FR-51** `payloadHash` = SHA-256 of canonical JSON with sorted keys over `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency`, and `referenceExternalTransactionId` when present. The key, `messageId`, `occurredAt` and transport metadata are excluded, so a replay matches across channels.

  **The algorithm**, which is part of the stored data (`payloadHash` in `src/wagering/application/payload-hash.ts`):

  1. Build an object of those fields, with `money` as `{ "amount", "currency" }` and the amount as its fixed two-decimal string.
  2. Serialize it as JSON with the keys of every object sorted ascending and no whitespace. A field that is absent is left out.
  3. Encode as UTF-8, hash with SHA-256, and write the digest as 64 lowercase hex characters.

  Ids are opaque: nothing is trimmed, case-folded or Unicode-normalized, and a provider that resends an id must resend the same text. Anything but a string or a plain object where a field belongs is refused, never coerced, because a number that slipped past validation would otherwise hash as text.

  Changing the field set, the order or the encoding makes every stored hash disagree with its own replay and report a false conflict, so it is a breaking change that needs a migration. A vector to check an implementation against, from the sample message of challenge section 10:

  ```text
  {"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}
  → 629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344
  ```
- **FR-52** Same key and same hash returns the original result with `idempotentReplay: true`: status, `failureCode` and balance as observed then. It publishes no event and changes nothing.
- **FR-53** Same key with a different hash is `IDEMPOTENCY_CONFLICT`, never a replay.
- **FR-54** Same `(providerId, externalTransactionId)` with a different key is `EXTERNAL_ID_CONFLICT`, since references and lookups depend on that pair being unique (`INT-14`). A row found under the request's own key is never this conflict, however it was found: it is a replay, or a key conflict if the payload differs.
- **FR-55** The balance observed at decision time is stored on the transaction, because `LOSS` and `REJECTED` have no ledger entry to read it from.
- **FR-56** A replay of a pending transaction returns its current state, and after settlement its final one.
- **FR-57** A `REJECTED` result is final for that key, even if the condition later clears. To try again, the provider sends a new `externalTransactionId`.
- **FR-58** `PLAYER_WALLET_MISMATCH` and `CURRENCY_MISMATCH` responses never include a balance: the first belongs to another player (`INT-15`), and the second is in a different currency from the transaction it would be recorded against (`INT-22`).

### 3.8 Failure codes (§7.2)

| Code | Stored | Provider action |
| --- | --- | --- |
| `INSUFFICIENT_FUNDS` | yes | Give up, or new id after funding |
| `REVERSAL_INSUFFICIENT_FUNDS` | yes | Escalate: operational case, not a player error |
| `CURRENCY_MISMATCH` | yes | Fix payload, new id |
| `PLAYER_WALLET_MISMATCH` | yes | Fix payload, new id |
| `REFERENCE_NOT_FOUND` | yes | New id once the reference exists |
| `REFERENCE_MISMATCH` | yes | Fix payload, new id |
| `REFERENCE_KIND_NOT_ALLOWED` | yes | Fix payload, new id |
| `REFERENCE_NOT_PROCESSED` | yes | Give up: the reference did not apply |
| `REFERENCE_AMOUNT_MISMATCH` | yes | Fix payload, new id |
| `ALREADY_REVERSED` | yes | Give up: already reversed |
| `BALANCE_LIMIT_EXCEEDED` | yes | Escalate |
| `SETTLEMENT_FAILED` | yes, status `FAILED` | Escalate: infrastructure could not settle it, and the payload is not at fault |
| `WALLET_NOT_FOUND` | no | Fix payload; same key may be resent |
| `IDEMPOTENCY_CONFLICT` | no | Fix the key or payload |
| `EXTERNAL_ID_CONFLICT` | no | Fix the key or id |
| `VALIDATION_ERROR` | no | Fix payload; same key may be resent |

### 3.9 HTTP (§9)

| Situation | Status |
| --- | --- |
| Applied, or replay of applied | `200` |
| Wallet created | `201` |
| Pending reference, or its replay | `202` |
| Invalid payload, missing key, bad cursor, `OPENING`, reserved provider | `400` |
| Body over the size limit | `413` |
| Wallet or transaction not found, or an unknown route | `404` |
| Not authenticated, or not allowed (when a guard exists, ADR-0009) | `401`, `403` |
| Idempotency, external id, or duplicate wallet conflict | `409` |
| Business rejection, or its replay | `422` |
| Transient infrastructure failure, with `Retry-After` | `503` |
| A stored transaction that ended in an infrastructure failure | `500` (terminal: a new id is needed) |

- **FR-60** The ledger uses an opaque, stable cursor; `limit` defaults to 50 with a maximum of 200, and a `limit` outside 1 to 200 is a `400`, not clamped, so a provider hears that it asked for more than it gets. The cursor means "after this wallet version", so entries added while paging are neither skipped nor repeated.
- **FR-61** Health endpoints are unauthenticated: `live` checks the process, `ready` checks PostgreSQL and SQS.
- **FR-62** The provider id `internal` is reserved for `OPENING` and rejected on input (`INT-16`). The domain enforces it both ways: `WagerTransaction.create` refuses the id and refuses the kind `OPENING`, and only `createOpening` can produce one, so the submit path cannot make an opening however a payload is shaped.
- **FR-63** Every error from a business endpoint is `{ "error": { "code", "message", "details"? } }`, with one mapping from situation to status for all endpoints ([ADR-0012](docs/adr/0012-errors-are-one-envelope-with-one-mapping.md)). `details` lists every field problem of a `400`. The message is written for the caller and never copied from the error.
- **FR-64** A request body is at most 16 KB (`413`) and must be a JSON object with exactly the documented fields; unknown fields are refused (`INT-25`). Query strings ignore parameters they do not know. Path ids must be UUIDs: a malformed one is a `400`, never a database error.
- **FR-65** Every response carries `X-Correlation-Id`: the caller's when it is plain (`[A-Za-z0-9._:-]`, at most 128 characters), otherwise a generated one, so a header value is never reflected. The id reaches the events.
- **FR-66** A process serves the wallet routes only when it has the `api` role; without it the routes do not exist and health and metrics still answer (ADR-0001).
- **FR-67** Reads take no lock and see committed state, so a wallet under heavy settlement can still be read. They run under the same statement timeout as writes (NFR-11).
- **FR-68** `POST /wagering/transactions` answers `200` for an applied transaction, `202` for one waiting for its reference, and `422` with a `failureCode` for a business rejection. A replay answers like the original and sets `idempotentReplay: true`. Applied, waiting, rejected, invalid, conflicting, missing and transient are seven different statuses.
- **FR-69** `GET /wagering/transactions/:transactionId` and `GET /providers/:providerId/wagering/transactions/:externalTransactionId` return the stored transaction, with the balance observed then. A balance the submission withheld (FR-58) is withheld here too.
- **FR-73** Every business controller carries the authentication guard, and a test fails if one does not (`ADR-0009`).
- **FR-74** A request waits for a database connection for at most `DATABASE_ACQUIRE_TIMEOUT_MS`, and an exhausted pool is a transient failure like a lock timeout (NFR-11).
- **FR-75** Provider ids and keys are 1 to 255 characters with no control characters; a violation is a `400` that names the field.

### 3.10 Reconciliation (§9)

- **FR-70** Compares the stored balance with the ledger sum, and checks the entry chain (each `balanceBefore` equals the previous `balanceAfter`).
- **FR-71** Reads a consistent snapshot without taking the wallet lock, so it does not stall a hot wallet.
- **FR-72** A divergence is logged, counted in a metric and flagged in the response. It is never corrected. `difference` is signed.

### 3.11 SQS consumer (§10)

| Outcome | Action |
| --- | --- |
| Processed, business rejection, pending, or replay | Commit, then ack |
| New `messageId` with a known idempotency key and matching hash | Replay, count as duplicate, ack |
| Known `(consumerName, messageId)` with matching hash | Ack |
| Database or lock failure | No ack, backoff through visibility; DLQ when attempts run out |
| Malformed JSON, unknown `type`, invalid payload, `OPENING` | DLQ |
| Same `messageId` with a different hash | DLQ (`INT-17`) |
| `IDEMPOTENCY_CONFLICT`, `EXTERNAL_ID_CONFLICT`, `WALLET_NOT_FOUND` | DLQ (`INT-17`) |

- **FR-76** The consumer calls the same use case as `POST /wagering/transactions`, and a message is held to the same field rules as the HTTP body (`SR-02`). The message adds `messageId`, `type` and `occurredAt`; an unknown field is refused.
- **FR-77** The inbox row `(consumerName, messageId)` is written in the transaction that settles the message, before the wallet lock, and rolls back with it. A message that is not settled leaves no inbox row, so its redelivery is not mistaken for a duplicate.
- **FR-78** A message is acknowledged only after the use case returned, which is after `COMMIT`. A failed acknowledgement is harmless: the redelivery finds the inbox row or the idempotency key and changes nothing.
- **FR-79** Messages of one wallet are handled in order, and when one is left unacknowledged the rest of its wallet in the same batch are left alone (`NFR-05`: this keeps order, it does not guarantee it).
- **FR-82** A transient failure makes the message invisible for a backoff that doubles with each delivery up to `QUEUE_BACKOFF_CAP_SECONDS`, drawn from the upper half of the ceiling so messages that failed together do not return together (`NFR-11`). Defaults: base 2 s, cap 30 s.
- **FR-83** A message gets `MAX_RECEIVE_COUNT` (5) deliveries. A permanent failure goes to the DLQ on its first, and a transient or unrecognised one on its last, by an explicit copy (the body unchanged, with `FailureKind`, `FailureReason` and `Receives` as message attributes) followed by the delete. A failed copy leaves the message in the queue. The queue's redrive policy, provisioned with the same number, is the backstop for a worker that dies mid-handling.
- **FR-80** On `SIGTERM`: stop polling, finish in-flight work within a deadline, return the visibility of the rest, and fail readiness. Stopping waits for the poll in progress and does not cancel it: a cancelled long poll is still open at the broker, which gives the next message to a connection nobody reads and hides it for the visibility timeout. Observed on the emulator. A poll is therefore short (`QUEUE_WAIT_SECONDS`, default 5, at most 20), and bounds how long stopping takes.
- **FR-81** On `SIGTERM`, the publisher and the reference worker stop claiming and finish what they hold. (The publisher is tested; the reference worker does not exist yet.) Anything unfinished is safe, because its lease expires and another instance takes it.

### 3.12 Events (§11)

| Outcome | Events |
| --- | --- |
| `PROCESSED` with balance change, including `OPENING` (`INT-18`) | `WagerTransactionProcessed`, `WalletBalanceChanged` |
| `LOSS` processed | `WagerTransactionProcessed` |
| `REJECTED`, including expiry | `WagerTransactionRejected` |
| `PENDING_REFERENCE` (first time only) | `WagerTransactionPendingReference` |
| Replay, or `FAILED` | None required by the minimum set; `FAILED` is logged and counted |

- **FR-90** Events are written in the same SQL transaction as the state change and published only by the outbox worker, to a dedicated queue `wagering-events.fifo` (`INT-19`).
- **FR-95** A publisher claims due rows with a lease in one statement (`FOR UPDATE SKIP LOCKED`), publishes outside any transaction and marks them published. Two publishers never claim the same row while its lease holds, and a publisher that dies delays its rows by at most one lease (`OUTBOX_LEASE_MS`). The `publisher` role runs it.
- **FR-96** When publishing fails, the failed row and the unattempted rest of the batch are rescheduled with an exponential, jittered backoff and the round ends. Rows are never given up on, and a publication is bounded by a timeout (`NFR-11`).
- **FR-91** Publication is at-least-once, with no attempt limit. `eventId` is the consumer's dedup key. `walletVersion` lets consumers restore balance order, since retries can reorder events.

#### 3.12.1 Event contract, version 1

Every event is stored in the outbox and published as this envelope. `eventType` and `version` belong to the event's type, so a payload cannot be emitted under the wrong name or version.

```json
{
  "eventId": "…", "eventType": "WalletBalanceChanged", "aggregateId": "<walletId>",
  "correlationId": "…", "causationId": "…", "occurredAt": "2026-11-05T12:00:00.000Z",
  "version": 1, "data": { }
}
```

`causationId` is omitted when there is none. `data` is plain JSON, with money as `{ "amount", "currency" }` and never a `Money` or a number.

| Event | `data` |
| --- | --- |
| `WagerTransactionProcessed` | the transaction facts¹, `balance` (after the operation; for a `LOSS`, the balance it saw), `referenceTransactionId` (when linked), `processedAt` |
| `WagerTransactionRejected` | the transaction facts¹, `failureCode`, `balance` (absent when the response withholds it, FR-58) |
| `WagerTransactionPendingReference` | the transaction facts¹, `referenceExternalTransactionId`, `balance` |
| `WalletBalanceChanged` | `walletId`, `transactionId`, `direction`, `money`, `balanceBefore`, `balanceAfter`, `walletVersion` |

¹ `transactionId`, `providerId`, `externalTransactionId`, `walletId`, `playerId`, `roundId`, `gameId`, `kind`, `money`.

- **FR-92** An event is built only from the state it describes. A transaction in the wrong status, a ledger entry from another wallet, and an entry that is not the wallet's latest change are refused, so an event can never publish a balance the wallet no longer has.
- **FR-93** The aggregate id of every event is the wallet id (`INT-23`).
- **FR-94** Adding a field to `data` keeps the version; removing, renaming or retyping one raises it, and the old version keeps being understood by consumers until they move.

---

## 4. Security requirements

- **SR-01** Logs carry correlation ids and no sensitive data or full financial payloads (§12).
- **SR-02** Every provider field from the queue passes the same domain validation as HTTP (§2).
- **SR-03** Without authentication, any caller can act as any provider. This is accepted by §2 and is **not** mitigated by anything else here; the extension point and intended design are in [ADR-0009](docs/adr/0009-authentication-is-a-documented-extension-point.md).
- **SR-04** Input is bounded: request body size, `Idempotency-Key` and identifier lengths, ledger page size. No unbounded value reaches a query, an index or a log.
- **SR-05** Domain rules apply to whoever submits: a provider cannot move another player's money by naming their wallet (`PLAYER_WALLET_MISMATCH`). This is a consistency check on the payload and **not** authorization: a caller who knows both ids passes it.
- **SR-06** The ledger is append-only, enforced by trigger. The table's owner or a superuser can disable the trigger, and in Compose the application connects as one; reconciliation can detect some such changes, not prevent them.

---

## 5. Non-functional requirements

- **NFR-01** Bun 1.x, strict TypeScript, NestJS, PostgreSQL, SQS via MiniStack ([ADR-0008](docs/adr/0008-ministack-is-the-local-sqs.md)), Docker Compose, MikroORM, reversible migrations (§4).
- **NFR-02** Enforced by the schema, not only by code (§5.9): wallet uniqueness, non-negative balance, idempotency and external-id uniqueness, one ledger entry per transaction, single `PROCESSED` reversal per reference (partial unique index on `reference_transaction_id` for `REFUND` and `ROLLBACK`), ledger immutability including `TRUNCATE`, and final terminal transactions.
- **NFR-03** No global lock. The concurrency unit is `walletId` (§5.6, §8). Correct with three or more instances (§5.8).
- **NFR-04** Inbox, financial change, ledger and outbox share one SQL transaction. Ack and publication happen only after commit (§5.4, §6.5, §10).
- **NFR-05** The broker's ordering and dedup are optimizations, never the guarantee (§5.3, §8).
- **NFR-06** Metrics: transactions by status, duplicates, retries, DLQ messages, lock conflicts, outbox lag, processing latency (§12).
- **NFR-07** All required tests in §13 run against real PostgreSQL and real LocalStack or MiniStack, with real parallelism.
- **NFR-08** All project text, code and commits are in English. Gitflow with Conventional Commits, checked on every commit and on the PR title.
- **NFR-09** Dependencies point inward: `domain` imports only itself; `application` imports domain and its own ports, never an adapter or framework. Checked by `check-boundaries.sh`, which also fails if it analysed nothing, and by `test/unit/architecture.test.ts`, which breaks each rule once on a throwaway tree and expects exactly those violations.
- **NFR-10** Every dependency and CI action is pinned exactly; the lockfile is frozen on install.
- **NFR-11** Every call to PostgreSQL or SQS is bounded by a timeout. Transient failures retry with exponential backoff and jitter, up to a limit, and retrying is safe because every operation is idempotent.
- **NFR-12** A change to behaviour updates its documents in the same pull request. A PR changing `src` or `migrations` without touching a document fails CI unless labelled `no-docs-needed`. This proves only that a document changed, not that it is right; that part stays a review question.

---

## 6. Integration requirements

- **IR-01** SQS delivers at least once and may reorder between groups. Nothing here relies on exactly-once delivery or on the broker's deduplication window.
- **IR-02** The broker honours per-group FIFO hold, deduplication ids, `ChangeMessageVisibility` and `maxReceiveCount` redrive. Each is checked against the real emulator in `test/integration/sqs-runtime.test.ts`, because emulators can differ from AWS.
- **IR-03** Event consumers deduplicate by `eventId` and order by `walletVersion`.

---

## 7. Interpretations

| Id | Decision | README basis | Option not taken |
| --- | --- | --- | --- |
| `INT-01` | Exactly two decimals required | §6.1 "always fixed scale of 2" | Normalizing `"25.5"`: the hash would need to see through formats |
| `INT-02` | `Money` signed internally | `negate` and `isNegative` exist in §6.1 | A separate signed type |
| `INT-03` | Input capped to fit the column | Unstated | Letting the database raise an overflow as a 500 |
| `INT-04` | `LOSS` may reference a `BET` | Table names only `WIN`, but §7.8 is generic | Rejecting: refuses a record that moves no money |
| `INT-05` | Only `LOSS` accepts `0.00` | `LOSS` moves nothing; ledger amounts must be positive | Rejecting zero everywhere |
| `INT-06` | One `PROCESSED` reversal per reference, of any kind. §7.4 forbids repeating a type but does not grant permission to mix types, so this breaks no written rule | §3 forbids duplicate credit: `BET` 80, `REFUND` +80, `ROLLBACK` of the `BET` +80 creates 80 from nothing. Also the §7 table's "once" | (a) `UNIQUE(reference, kind)` alone allows that double credit. (b) Allowing a second reversal only after the first was itself rolled back would be correct, but the cross-kind guard could no longer live in the schema (§5.9). Cost accepted: `REFUND`, `ROLLBACK` of it, then `ROLLBACK` of the `BET` is refused and needs an operator |
| `INT-07` | No round state machine | §7 defines none | Modeling round open/closed |
| `INT-08` | Multiple `BET`/`WIN` per round | §7 forbids nothing; multi-payout games exist | One `WIN` per `BET` |
| `INT-09` | `WIN` on a reversed `BET` rejected | Unstated; protects against paying a voided bet | Allowing it. A `REFUND` after an existing `WIN` is still allowed, so this protection is one-directional |
| `INT-10` | Synchronous settlement | §9 sample returns `PROCESSED` | Enqueuing all HTTP submissions |
| `INT-11` | `FAILED` limited to stored rows | No row exists before the first commit | Writing a separate failure transaction |
| `INT-12` | Unknown wallet stores nothing | The transaction requires a wallet reference | Dropping the foreign key to store the rejection |
| `INT-13` | 1 h TTL | §7.1 asks for a justified limit | Attempt count: its real duration is harder to reason about |
| `INT-14` | External id unique, separately from the key | §9 lookup and §7.2 resolution need one result | Allowing two keys to share an id |
| `INT-15` | No balance on player mismatch | Data exposure | Uniform response shape |
| `INT-16` | `internal` provider reserved | §6.3 `OPENING` is internal | Nullable provider columns on `OPENING` |
| `INT-17` | Queue conflicts go to DLQ | §10 permanent errors; a queue has no caller to answer | Ack with a dedicated audit table |
| `INT-18` | `OPENING` publishes events | §11 "any applied transaction" | Silent opening |
| `INT-19` | Separate event queue | §10 defines only input and DLQ queues | Publishing into the input queue, which would feed consumers their own events |
| `INT-20` | `FAILED` carries its own code, `SETTLEMENT_FAILED` | §7.2 wants a stable code on every terminal outcome, and `FAILED` is not a business rejection | Reusing a business code: the provider would read our fault as its own payload error |
| `INT-21` | An `OPENING` derives its keys from the wallet id | One opening per wallet is then enforced by the unique idempotency key in the schema, not only by code | Random keys: a second opening would be a different row, and nothing would refuse it |
| `INT-22` | `CURRENCY_MISMATCH` carries no balance | An observed balance is recorded in the transaction's own currency, and the wallet's is in another | Converting or storing the wallet's currency alongside: a second currency field on every row for one rejection |
| `INT-23` | Every event's aggregate id is the wallet id, including the transaction events | The outbox uses it as the FIFO message group (ADR-0007), and a wallet is the unit of ordering and concurrency (§8) | The transaction id: events of one wallet would then spread over many groups and lose their order |
| `INT-24` | Wallet, player and transaction ids are `uuid` columns; provider ids, external ids and keys are `varchar(255)` | The challenge's samples are UUIDs, and a bounded column backs SR-04 at the last line | `text` everywhere: nothing would bound an indexed value, and an over-long key would fail with an index-size error |
| `INT-25` | Ids are accepted in any case and handled in lowercase; bodies refuse unknown fields; query strings ignore them | Ids are compared as text and PostgreSQL stores a UUID in lowercase, so a retry in another case must not become another player. A body field we would silently drop is a typo the provider should hear about, while an extra query parameter (a tracking tag) carries nothing we store | Case-sensitive ids. Ignoring unknown body fields, which loses data without a word |
| `INT-26` | Creating a wallet is not idempotent: a second request for the same player and currency is a `409`, even if identical | §9: a duplicate "must fail as a conflict" | A key on wallet creation, which would make a retry safe at the cost of what the challenge asked for. A retry after a timeout can find the wallet exists, and reads it with `GET` |

---

## 8. Out of scope

- Authentication implementation (§2): decision and design go in `ARCHITECTURE.md`.
- Double-entry ledger, OpenTelemetry and dashboards (§6.4, §12): optional.
- Load test (`bun run test:load`, §14): optional, done last if time allows.
