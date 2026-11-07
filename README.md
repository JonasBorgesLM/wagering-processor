# wagering-processor

A distributed financial service that applies betting operations from game providers to player wallets, and stays correct when messages are duplicated, arrive out of order, run simultaneously, or a process dies mid-operation.

Built for the [Jungle Gaming backend challenge](https://github.com/junglegaming/backend-challenge).

> **Status: feature complete, awaiting release.** Everything the challenge asks for is implemented and tested against real PostgreSQL and a real SQS emulator, including a failure suite with real processes. What is **not** here is listed under [Known limitations](#known-limitations), and it matters: read it before relying on this.

---

## What it does

A provider sends `BET`, `WIN`, `LOSS`, `REFUND` and `ROLLBACK` operations over HTTP or through an SQS queue. Each one is applied to a player's wallet exactly once, however many times it is sent, in whatever order, through whichever of several instances. Every balance change has a ledger entry, and the stored balance always equals what the ledger rebuilds.

- **Money is exact.** `Money` holds a `bigint` of minor units, parses only `"25.00"`-shaped strings and has no rounding path.
- **The database is the last defence.** Uniqueness of the idempotency key and of the provider's own id, non-negative balances, the single-reversal rule, the ledger's arithmetic, and append-only triggers are constraints, each tested in raw SQL. A bug in the code cannot overdraw a wallet or debit twice.
- **One transaction per operation, under a lock on the wallet row.** The operation, the balance, the ledger entry, the inbox row and the events commit together; responding, acknowledging and publishing happen after the commit and are safe to repeat.
- **HTTP and SQS are the same use case.** The consumer validates a message with the rules of the HTTP body, records it in a persistent inbox, deletes it only after the commit, retries a transient failure with a jittered backoff and sends a permanent one, or one out of attempts, to the DLQ with its reason.
- **Events go through an outbox.** A publisher claims rows with a lease (`FOR UPDATE SKIP LOCKED`), publishes outside any transaction to `wagering-events.fifo` and marks them. Delivery is at least once: consumers deduplicate on `eventId` and order by `walletVersion`.
- **A reversal can arrive before its bet.** It waits with its schedule on the row, a worker settles it when the bet is there, and after the TTL (1 h) it is rejected `REFERENCE_NOT_FOUND`.
- **Reconciliation** compares the stored balance with the ledger in one snapshot, without a lock, and flags a divergence in the response, the log and a metric. It never corrects.
- **It stops cleanly.** On `SIGTERM` readiness reports `draining`, the consumer finishes the message in hand and gives the rest back to the queue, and the publisher and the reference worker finish their round.
- **It is observable.** JSON logs with correlation fields and no payload, Prometheus metrics for every item of the challenge, liveness and readiness.

How it was shown to work, and not only that it does: the unit suite (domain rules, the order of the settlement checks by swapping each pair), the integration suite (constraints, atomicity, inbox, outbox, retry and DLQ with PostgreSQL really stopped), and a failure suite that runs the eight mandatory scenarios of the challenge against three or more real processes, kills them at states the test has found (an acknowledgement or a publish held at a proxy in front of the real broker, a wallet lock the test holds) and ends every test on `balance == ledger rebuild`. Protections were removed once each and the suite seen red; ARCHITECTURE.md lists them.

## Known limitations

- **No authentication.** Nothing identifies a caller (ADR-0009, T-03). Do not expose it.
- **Throughput is not measured.** The lock, pool, backoff and lease defaults are judgements, each with its reasoning in ARCHITECTURE.md, and none has been checked under sustained load.
- **A database outage longer than about 30 s dead-letters the messages in flight** with the default retry settings. Nothing is lost and replaying them is safe, but replaying is manual: there is no tool for it.
- **A waiting reversal is settled at its next look,** up to the current backoff (5 s, doubling to 5 min) after its bet arrives, and a bet that arrives after its reversal expired is applied normally (no tombstone).
- **Events can arrive twice and out of order** within a wallet after a retry. That is the contract (IR-03), and a consumer that ignores it will be wrong.
- **Superuser tampering is undetectable** here: someone who disables the triggers and edits balance and ledger consistently leaves nothing to reconcile (T-09). In Compose the application connects as a superuser, so the triggers stop mistakes, not a hostile operator.
- **Reconciliation scans the wallet's whole ledger** on every call. A wallet with millions of entries would want an incremental check.
- **Shutdown in the middle of a settlement** is tested for the consumer with a message in flight, not for the publisher or the reference worker mid-round.
- **Single region, single broker, no tracing, no dashboards, no alert rules.**

---

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

## Configuration

All through environment variables; `.env.example` has the defaults and a bad value stops the process at start. `APP_ROLES` chooses what one process does (ADR-0001): `api`, `consumer`, `publisher`, `reference-worker`, comma separated, all four by default.

| Variable | Default | What it bounds |
| --- | --- | --- |
| `PORT`, `DATABASE_URL`, `AWS_REGION`, `SQS_ENDPOINT` | see `.env.example` | where it listens and what it talks to |
| `SHUTDOWN_TIMEOUT_MS` | 25000 | how long a stopping process may take before it exits 1 |
| `LOCK_TIMEOUT_MS`, `STATEMENT_TIMEOUT_MS` | 2000, 5000 | the wait for a wallet lock; the longest any statement may run |
| `DATABASE_POOL_MAX`, `DATABASE_ACQUIRE_TIMEOUT_MS` | 10, 1000 | connections per process; the wait to get or open one |
| `QUEUE_WAIT_SECONDS` | 5 | one poll of the input queue, and so the longest stopping the consumer can take |
| `QUEUE_BACKOFF_BASE_SECONDS`, `QUEUE_BACKOFF_CAP_SECONDS` | 2, 30 | the wait before a failed message is delivered again |
| `OUTBOX_POLL_INTERVAL_MS`, `OUTBOX_BATCH_SIZE`, `OUTBOX_LEASE_MS` | 500, 25, 30000 | how the publisher polls, claims and how long a claim is held |
| `OUTBOX_RETRY_BASE_SECONDS`, `OUTBOX_RETRY_CAP_SECONDS` | 1, 60 | the wait before a failed publication is tried again (no attempt limit) |
| `REFERENCE_TTL_SECONDS` | 3600 | how long a reversal waits for its reference |
| `REFERENCE_RETRY_BASE_SECONDS`, `REFERENCE_RETRY_CAP_SECONDS` | 5, 300 | the wait between looks at a waiting reversal |
| `REFERENCE_BATCH_SIZE`, `REFERENCE_LEASE_MS`, `REFERENCE_POLL_INTERVAL_MS` | 25, 30000, 1000 | how the reference worker polls and claims |

The reasoning behind each default, and what it does not guarantee, is in ARCHITECTURE.md.

## Commands

| Command | What it does |
| --- | --- |
| `bun run typecheck` | Strict TypeScript |
| `bun run lint` | Biome, layer boundaries, money guard |
| `bun run test:unit` | Unit tests, no services needed |
| `bun run test:integration` | Needs `docker compose up postgres sqs` |
| `bun run test:concurrency` | Real parallel connections, and the multi-process failure suite: the eight scenarios of §13 against three or more real application processes, killed and restarted. Needs the same services; takes a few minutes |
| `bun run check:docs` | ADR index, cited requirement and threat ids, every requirement cited by a test or source file, relative links |
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
# {"transactionId":"…","status":"PROCESSED","idempotentReplay":false,"balance":{"amount":"975.00","currency":"BRL"}}
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
