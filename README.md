# wagering-processor

A distributed financial service that applies betting operations from game providers to player wallets, and stays correct when messages are duplicated, arrive out of order, run simultaneously, or a process dies mid-operation.

Built for the [Jungle Gaming backend challenge](https://github.com/junglegaming/backend-challenge).

> **Status: early.** The runtime, tooling, CI, documents, `Money`, `Wallet` and the ledger entry are in place. **There is no wallet, transaction or ledger code yet**, so this does not process a bet today. See the [roadmap](ARCHITECTURE.md#roadmap).

---

## What works today

- The application boots on Bun with NestJS and MikroORM, as several instances selected by role.
- `GET /health/live` and `GET /health/ready`, with real PostgreSQL and SQS checks, and `GET /metrics`.
- `SIGTERM` drains through the shutdown hooks.
- Structured JSON logs with an allowlist of fields.
- `Money`: exact `bigint` arithmetic with strict contract parsing and no rounding path.
- `Wallet` and `WalletLedgerEntry`: a balance that cannot go negative, whose every change returns the entry that records it, and an entry that cannot be built unbalanced or changed afterwards. These are domain classes only; nothing stores them yet.
- Designed but not implemented: idempotency, duplicate control, consistency and resilience, described in [Patterns](ARCHITECTURE.md#patterns).
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
| `bun run check:docs` | ADR index, cited ids, relative links |

## Documents

| Document | Content |
| --- | --- |
| [`REQUIREMENTS.md`](REQUIREMENTS.md) | Business rules, `REFUND`/`ROLLBACK` definitions, failure codes, interpretations |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | Layers, signatures, flows, schema, limitations |
| [`THREAT-MODEL.md`](THREAT-MODEL.md) | What can go wrong, including what is not covered |
| [`docs/adr/`](docs/adr/README.md) | Contested decisions and the options rejected |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Gitflow, commits, checks |
| [Project board](https://github.com/users/JonasBorgesLM/projects/10) | Development steps and live status (private until delivery) |
