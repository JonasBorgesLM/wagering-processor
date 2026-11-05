# wagering-processor

A distributed financial service that applies betting operations from game providers to player wallets, and stays correct when messages are duplicated, arrive out of order, run simultaneously, or a process dies mid-operation.

Built for the [Jungle Gaming backend challenge](https://github.com/junglegaming/backend-challenge).

> **Status: early.** The runtime, tooling, CI, documents, `Money`, `Wallet`, the ledger entry, the transaction lifecycle, the settlement rules, the integration events, the payload hash, the database schema, the persistence mappers, the settlement use case and the wallet API are in place. **There is no wallet, transaction or ledger code yet**, so this does not process a bet today. See the [roadmap](ARCHITECTURE.md#roadmap).

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
- Wallets over HTTP: create, read and page the ledger, with one error envelope, a body limit and correlation ids, tested end to end against a real database. See the API section below.
- Settlement: `SubmitWagerTransaction` takes the wallet lock, answers replays and conflicts, and commits the transaction, balance, ledger entry and events together, tested with real parallel connections on PostgreSQL. **It is not reachable yet:** there is no endpoint that submits a bet or queue consumer, and nothing publishes the stored events.
- Designed but not implemented: the inbox, publishing, retries and full shutdown, described in [Patterns](ARCHITECTURE.md#patterns).
- Contract tests on what the design relies on: row-lock serialization, the deadlock that fixes the lock order, exact `NUMERIC` strings, reversible migrations, FIFO group hold, deduplication, visibility and DLQ redrive.

**Not verified yet:** draining with messages in flight, because the consumer does not exist.

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

Wallets are the only part reachable over HTTP so far. **There is no endpoint that submits a bet yet** (issue #14).

| Request | Answer |
| --- | --- |
| `POST /wallets` | `201` and the wallet; `409` if the player already has one in that currency |
| `GET /wallets/:walletId` | `200`; `404` if there is none |
| `GET /wallets/:walletId/ledger?limit=50&cursor=…` | `200` with `items` and `nextCursor` (`null` on the last page) |
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

Every error looks the same, and the status tells a provider what to do:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "the request is not valid",
             "details": [{ "field": "initialBalance", "reason": "…" }] } }
```

| Status | Meaning | Resend the same request? |
| --- | --- | --- |
| `400` | The request is wrong (`details` says which fields) | No: fix it |
| `404` | No such wallet or route | No |
| `409` | Conflicts with something that exists | No |
| `413` | Body over the limit | No |
| `503` | Nothing was changed; try again (`Retry-After: 1`) | **Yes** |
| `500` | A bug; the cause is logged, never sent | Report it |

## Documents

| Document | Content |
| --- | --- |
| [`REQUIREMENTS.md`](REQUIREMENTS.md) | Business rules, `REFUND`/`ROLLBACK` definitions, failure codes, interpretations |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Layers, signatures, flows, schema, limitations |
| [`THREAT-MODEL.md`](THREAT-MODEL.md) | What can go wrong, including what is not covered |
| [`docs/adr/`](docs/adr/README.md) | Contested decisions and the options rejected |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Gitflow, commits, checks |
| [Project board](https://github.com/users/JonasBorgesLM/projects/10) | Development steps and live status (private until delivery) |
