# wagering-processor

A distributed financial service that applies betting operations from game providers to player wallets, and stays correct when messages are duplicated, arrive out of order, run simultaneously, or a process dies mid-operation.

Built for the [Jungle Gaming backend challenge](https://github.com/junglegaming/backend-challenge).

> **Status: early.** The runtime, tooling, CI, documents, `Money`, `Wallet`, the ledger entry, the transaction lifecycle, the settlement rules, the integration events, the payload hash, the database schema, the persistence mappers, the settlement use case, the HTTP API, the queue consumer and the outbox publisher are in place. The remaining metrics, the failure suite and the final documents are still to come. See the [roadmap](ARCHITECTURE.md#roadmap).

---

## What works today

- The application boots on Bun with NestJS and MikroORM, as several instances selected by role.
- `GET /health/live` and `GET /health/ready`, with real PostgreSQL and SQS checks, and `GET /metrics`.
- `SIGTERM` drains: readiness reports `draining`, the consumer stops polling, finishes the message in hand within `SHUTDOWN_TIMEOUT_MS`, and gives the rest back to the queue at once. Past the deadline the process exits 1 and the queue's visibility timeout returns what was unacknowledged. Tested on the real process with a message in flight.
- Structured JSON logs with an allowlist of fields.
- `Money`: exact `bigint` arithmetic with strict contract parsing and no rounding path.
- `Wallet` and `WalletLedgerEntry`: a balance that cannot go negative, whose every change returns the entry that records it, and an entry that cannot be built unbalanced or changed afterwards. These are domain classes only; nothing stores them yet.
- Integration events (`WagerTransactionProcessed`, `Rejected`, `PendingReference`, `WalletBalanceChanged`) with a versioned, frozen, plain-JSON payload, and `payloadHash`, the SHA-256 of a canonical JSON that makes one operation hash the same over HTTP and SQS. The hash is pinned by vectors computed with Python, and the events by their expected JSON written out in the tests. Nothing publishes or stores them yet.
- `decideSettlement`: the rules that choose an outcome for an operation (apply, reject with a stable code, or wait for its reference), as a pure function with no I/O. Nothing runs it against a database yet.
- `WagerTransaction`: the lifecycle of an operation, where `PROCESSED`, `REJECTED` and `FAILED` are terminal and every other move is refused. It cannot be made into an `OPENING` through the submit path. 
- The database schema in a reversible migration, with uniqueness, non-negative balances, the single-reversal rule and the ledger's arithmetic enforced by constraints, each tested in raw SQL. Triggers make the ledger append-only and settled transactions final. Nothing writes to these tables yet.
- Persistence records and mappers between the domain and the tables, tested through a real PostgreSQL round trip with amounts beyond what a double holds. Nothing uses them yet: the settlement use case that reads and writes through them is next.
- The layer rules are tested by breaking each one on purpose, not only by running the checker on code that obeys them.
- The HTTP API: wallets, bets and reads of a transaction, with the idempotency header, one error envelope, a body limit and correlation ids, tested end to end against a real database with real parallelism, and checked across three processes. See the API section below.
- Settlement: `SubmitWagerTransaction` takes the wallet lock, answers replays and conflicts, and commits the transaction, balance, ledger entry and events together, tested with real parallel connections on PostgreSQL. The `publisher` role then sends the stored events to `wagering-events.fifo`.
- The SQS consumer (`consumer` role): it reads `wager-transactions.fifo`, validates a message with the rules of the HTTP body, settles it with the same use case, and deletes it only after the commit. The inbox row is written in the settling transaction, so a rollback takes it too. Tested against the real broker, including a worker that commits and dies before acknowledging: the redelivery changes nothing. A permanent failure goes to the DLQ at once with its reason; a transient one is retried with a jittered, growing backoff and goes to the DLQ after 5 deliveries. Tested with PostgreSQL really stopped. **An outage longer than about 30 s with the defaults dead-letters what was in flight** (safe to replay, but manual).
- The outbox publisher (`publisher` role): claims due rows with a lease (`FOR UPDATE SKIP LOCKED`, one statement), publishes outside any transaction to `wagering-events.fifo` (group = wallet, deduplication id = `eventId`), then marks the row. Tested with several publishers at once (every event sent once), a publisher that dies after claiming (another takes the rows when the lease ends), a broker that is away (rows back off, none lost, publish when it returns), a crash between publishing and marking (published again under the same `eventId`), and as a real process that drains on `SIGTERM`. **Delivery is at least once:** a consumer of the events must deduplicate on `eventId` and order by `walletVersion`.
- The pending-reference worker (`reference-worker` role): a `REFUND` or `ROLLBACK` that arrives before its bet waits, with its schedule on the row, and is settled at a later look by running the same settlement order under the wallet lock. After the TTL (1 h by default) it is rejected `REFERENCE_NOT_FOUND` and an event says so. A reversal waiting on another waiting reversal keeps waiting. Tested with 60 waiting reversals across 4 workers (each claimed and settled once) and as a real process. **A waiting reversal is settled at its next look, up to the current backoff after its bet arrives, and a bet that arrives after the reversal expired is applied normally (no tombstone).**
- Reconciliation (`POST /wallets/:walletId/reconciliation`): compares the stored balance with the ledger, and checks that every entry adds up, is in the wallet's currency and continues the one before. One statement, so it is a single snapshot, and no lock, so a busy wallet is not stalled. A divergence is flagged in the response, logged as an error with the wallet, and counted (`wagering_reconciliations_total{result="divergent"}`); **it is never corrected.** Tested with divergences injected through SQL, with a held wallet lock, and against 80 bets committing during 60 checks.
- Metrics and correlated logs, described under Observability below.
- The failure suite (`test/concurrency/multiprocess.test.ts`): the eight mandatory scenarios of §13 with real processes, ending each on `balance == ledger rebuild`. A process is killed at a state the test has found, not at a moment it hoped for: an acknowledgement or a publish held at a proxy in front of the real broker, a wallet lock the test holds. Seven protections were removed once each and seen red (see ARCHITECTURE.md).
- Not done yet: the final documents and the release, described in [Patterns](ARCHITECTURE.md#patterns).
- Contract tests on what the design relies on: row-lock serialization, the deadlock that fixes the lock order, exact `NUMERIC` strings, reversible migrations, FIFO group hold, deduplication, visibility and DLQ redrive.

**Not verified yet:** draining while a worker is in the middle of a settlement (the process test signals an idle worker). The consumer's, the publisher's and the reference worker's stop paths are tested; stopping waits for the poll in progress, at most `QUEUE_WAIT_SECONDS`.

## A rule worth knowing first

A `BET` can be reversed **once**, by `REFUND` or by `ROLLBACK`, never both. The challenge only forbids repeating the same type, but allowing both would credit the stake twice. This is a deliberate, confirmed reading: see [ADR-0006](docs/adr/0006-one-processed-reversal-per-reference.md).

## Requirements

- [Bun](https://bun.sh) 1.4 or later
- Docker with Compose

## Setup

```bash
bun install
cp .env.example .env
docker compose up -d --wait postgres sqs
bun run provision        # create the queues
bun run migrate up
bun run start
```

```bash
curl localhost:3000/health/ready
```

To run three instances in containers:

```bash
docker compose --profile app up -d --build
curl localhost:3001/health/ready   # also 3002, 3003
```

## Commands

| Command | What it does |
| --- | --- |
| `bun run typecheck` | Strict TypeScript |
| `bun run lint` | Biome, layer boundaries, money guard |
| `bun run test:unit` | Unit tests, no services needed |
| `bun run test:integration` | Needs `docker compose up postgres sqs` |
| `bun run test:concurrency` | Real parallel connections, and the multi-process failure suite: the eight scenarios of §13 against three or more real application processes, killed and restarted. Needs the same services; takes a few minutes |
| `bun run check:docs` | ADR index, cited ids, relative links |
| `./.github/scripts/check-instances.sh` | Needs `docker compose --profile app up -d --build --wait`: three processes behave as one system |

## API

Wallets and transactions are reachable over HTTP. **Nothing authenticates a caller yet** (ADR-0009), so do not expose it.

| Request | Answer |
| --- | --- |
| `POST /wallets` | `201` and the wallet; `409` if the player already has one in that currency |
| `GET /wallets/:walletId` | `200`; `404` if there is none |
| `GET /wallets/:walletId/ledger?limit=50&cursor=…` | `200` with `items` and `nextCursor` (`null` on the last page) |
| `POST /wallets/:walletId/reconciliation` | `200` with the stored balance, the balance the ledger adds up to, their signed `difference`, `consistent`, `checkedEntries`, and the entries with a problem. Changes nothing; takes no lock; `404` for an unknown wallet |
| `POST /wagering/transactions` | `200` applied, `202` waiting for its reference, `422` refused by a rule (with `failureCode`); `Idempotency-Key` header required |
| `GET /wagering/transactions/:transactionId` | `200`, or `404` |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | `200`, or `404` |
| `GET /health/live`, `GET /health/ready`, `GET /metrics` | liveness, readiness (`503` if PostgreSQL or SQS is down), Prometheus |

```bash
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
# {"id":"…","playerId":"0192f28f-…","balance":{"amount":"1000.00","currency":"BRL"},"version":1}
```

- **Amounts are strings with exactly two decimals.** `"25"`, `"25.5"`, `-1.00` and `1e3` are refused, never rounded.
- **A positive balance is funded by an internal `OPENING` transaction**, so the ledger explains the balance from the start. `version` stays at 1.
- **`limit` is 1 to 200** and out of range is a `400`, not silently clamped. The cursor stays valid while entries are added.
- **Bodies are limited to 16 KB and refuse unknown fields.** Ids are UUIDs, in any case.
- **Every response has `X-Correlation-Id`**: yours if it is plain, otherwise a generated one.

```bash
curl -s -X POST localhost:3000/wagering/transactions -H 'content-type: application/json' \
  -H 'idempotency-key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123","playerId":"…","walletId":"…",
       "roundId":"round-987","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
# {"transactionId":"…","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}
```

- **Sending it again with the same key returns the same answer** with `"idempotentReplay": true` and changes nothing. The same key with a different payload is a `409`.
- **The operations** are `BET`, `WIN`, `LOSS`, `REFUND` and `ROLLBACK`. A `REFUND` or `ROLLBACK` names what it reverses in `referenceExternalTransactionId`; if that has not arrived yet the answer is `202` and it is applied when it does.
- **A `422` is final for that key.** To try again after the cause is gone, send a new `externalTransactionId`.

Every error looks the same, and the status tells a provider what to do:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "the request is not valid",
             "details": [{ "field": "initialBalance", "reason": "…" }] } }
```

| Status | Meaning | Resend the same request? |
| --- | --- | --- |
| `400` | The request is wrong (`details` says which fields) | No: fix it |
| `404` | No such wallet, transaction or route | No |
| `409` | Conflicts with something that exists | No |
| `422` | A business rule refused it (`failureCode` says which) | No: a new id after the cause is gone |
| `202` | Accepted, waiting for the transaction it points at | No: it is applied when that arrives |
| `413` | Body over the limit | No |
| `503` | Nothing was changed; try again (`Retry-After: 1`) | **Yes** |
| `500` | A bug, or a transaction that ended in a failure; the cause is logged, never sent | Report it |

## Observability

Logs are JSON, one line per event, with the fields that tie it together: `correlationId` (the `X-Correlation-Id` the caller sent when it is plain, otherwise generated, and the message id on the queue), `messageId`, `transactionId`, `walletId`, `providerId`, `status`, `failureCode` and `durationMs`. **Only those fields are written**: the logger drops anything else, so an amount, a player, a round, a game or an idempotency key cannot reach a log through a context object. A test submits a payload made of unmistakable values over HTTP and over the queue and searches every log line for them. A refused request is logged with its code and not its message, because the message can carry the key.

`GET /metrics` (Prometheus):

| Metric | Labels | What moves it |
| --- | --- | --- |
| `wagering_transactions_total` | `status`, `kind`, `source` (`http`, `sqs`, `reference_worker`) | a decision gave a transaction a status; a replay does not count |
| `wagering_duplicates_total` | `kind`: `replay`, `idempotency_conflict`, `external_id_conflict`, `message_id_conflict` | a replay answered from the stored result, or a conflict refused |
| `wagering_retries_total` | `component`: `consumer`, `outbox`, `reference_worker`, `duplicate_race` | work put back to be tried again |
| `wagering_dlq_messages_total` | `reason`: `permanent`, `attempts-exhausted` | a message copied to the dead-letter queue |
| `wagering_lock_conflicts_total` | `kind`: `lock_timeout`, `deadlock` | a wallet lock wait that ended in one of them |
| `wagering_database_transient_failures_total` | `reason` | any database call that failed in a way retrying may fix (includes the lock conflicts) |
| `wagering_outbox_lag_seconds`, `wagering_outbox_unpublished` | none | measured when scraped: the age of the oldest event not yet published, and how many are waiting |
| `wagering_settlement_duration_seconds` | `source`, `outcome` (`decided`, `replay`, `error`) | histogram of one settlement, first line of the use case to its return |
| `wagering_reconciliations_total` | `result` | a reconciliation, consistent or divergent |

No label takes a value from a request (a wallet, a provider, a key), because that would make the number of series unbounded. The counters an alert would watch start at zero, so a rate over one that has not happened yet is 0 and not absent; the `wagering_transactions_total` series appear with their first transaction. **Not provided:** dashboards, tracing, and alert rules; the metrics are the raw material.

## Documents

| Document | Content |
| --- | --- |
| [`REQUIREMENTS.md`](REQUIREMENTS.md) | Business rules, `REFUND`/`ROLLBACK` definitions, failure codes, interpretations |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Layers, signatures, flows, schema, limitations |
| [`THREAT-MODEL.md`](THREAT-MODEL.md) | What can go wrong, including what is not covered |
| [`docs/adr/`](docs/adr/README.md) | Contested decisions and the options rejected |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Gitflow, commits, checks |
| [Project board](https://github.com/users/JonasBorgesLM/projects/10) | Development steps and live status (private until delivery) |
