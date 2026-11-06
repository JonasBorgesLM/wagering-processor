# wagering-processor

A distributed financial service that applies betting operations from game providers to player wallets, and stays correct when messages are duplicated, arrive out of order, run simultaneously, or a process dies mid-operation.

Built for the [Jungle Gaming backend challenge](https://github.com/junglegaming/backend-challenge).

> **Status: early.** The runtime, tooling, CI, documents, `Money`, `Wallet`, the ledger entry, the transaction lifecycle, the settlement rules, the integration events, the payload hash, the database schema, the persistence mappers, the settlement use case, the HTTP API and the queue consumer are in place. Nothing publishes the stored events yet, and retries, the dead-letter path and draining are still to come. See the [roadmap](ARCHITECTURE.md#roadmap).

---

## What works today

- The application boots on Bun with NestJS and MikroORM, as several instances selected by role.
- `GET /health/live` and `GET /health/ready`, with real PostgreSQL and SQS checks, and `GET /metrics`.
- `SIGTERM` drains through the shutdown hooks.
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
- Settlement: `SubmitWagerTransaction` takes the wallet lock, answers replays and conflicts, and commits the transaction, balance, ledger entry and events together, tested with real parallel connections on PostgreSQL. Nothing publishes the stored events yet.
- The SQS consumer (`consumer` role): it reads `wager-transactions.fifo`, validates a message with the rules of the HTTP body, settles it with the same use case, and deletes it only after the commit. The inbox row is written in the settling transaction, so a rollback takes it too. Tested against the real broker, including a worker that commits and dies before acknowledging: the redelivery changes nothing. **A message that fails is left unacknowledged and the queue's receive limit sends it to the DLQ after 5 receives; immediate dead-lettering and jittered backoff are #16.**
- Designed but not implemented: publishing, retries with backoff, the dead-letter shortcut and the draining deadline, described in [Patterns](ARCHITECTURE.md#patterns).
- Contract tests on what the design relies on: row-lock serialization, the deadlock that fixes the lock order, exact `NUMERIC` strings, reversible migrations, FIFO group hold, deduplication, visibility and DLQ redrive.

**Not verified yet:** draining with messages in flight (#17). Stopping the consumer is tested only for an idle one: it waits for the poll in progress, at most `QUEUE_WAIT_SECONDS`.

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
| `bun run test:concurrency` | Real parallel connections; needs the same services |
| `bun run check:docs` | ADR index, cited ids, relative links |
| `./.github/scripts/check-instances.sh` | Needs `docker compose --profile app up -d --build --wait`: three processes behave as one system |

## API

Wallets and transactions are reachable over HTTP. **Nothing authenticates a caller yet** (ADR-0009), so do not expose it.

| Request | Answer |
| --- | --- |
| `POST /wallets` | `201` and the wallet; `409` if the player already has one in that currency |
| `GET /wallets/:walletId` | `200`; `404` if there is none |
| `GET /wallets/:walletId/ledger?limit=50&cursor=…` | `200` with `items` and `nextCursor` (`null` on the last page) |
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

## Documents

| Document | Content |
| --- | --- |
| [`REQUIREMENTS.md`](REQUIREMENTS.md) | Business rules, `REFUND`/`ROLLBACK` definitions, failure codes, interpretations |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Layers, signatures, flows, schema, limitations |
| [`THREAT-MODEL.md`](THREAT-MODEL.md) | What can go wrong, including what is not covered |
| [`docs/adr/`](docs/adr/README.md) | Contested decisions and the options rejected |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Gitflow, commits, checks |
| [Project board](https://github.com/users/JonasBorgesLM/projects/10) | Development steps and live status (private until delivery) |
