# Architecture

How `wagering-processor` is built, and why. Rules live in [`REQUIREMENTS.md`](REQUIREMENTS.md), threats in [`THREAT-MODEL.md`](THREAT-MODEL.md), contested decisions in [`docs/adr/`](docs/adr/README.md).

> **Status: base only.** The platform layer, tooling and runtime contract tests exist and pass. Everything under `src/wagering` and `src/messaging` below is **designed, not implemented**: signatures have no bodies yet. See [Roadmap](#roadmap).

---

## The idea in one paragraph

PostgreSQL is the only source of truth. Each operation runs as one SQL transaction under a lock on its wallet row, and that transaction records the operation, the balance change, the ledger entry, the inbox row and the outbound events together. Everything outside that transaction, such as responding, acknowledging and publishing, happens after commit and can safely repeat. The broker is treated as an unreliable courier, and the schema as the last defence when the code is wrong.

## Layers

One deployable, one bounded context ([ADR-0001](docs/adr/0001-one-deployable-with-role-selected-processes.md)). Dependencies point inward, checked by `check-boundaries.sh` (NFR-09).

```text
src/
  wagering/
    domain/          Money, Wallet, WagerTransaction, WalletLedgerEntry,
                     SettlementPolicy, FailureCode, integration events
    application/     use cases and the ports they need
    infrastructure/  http/  sqs/  persistence/  (adapters)
  messaging/         inbox and outbox: classes, publisher, lease claim
  platform/          config, logging, metrics, health, database, SQS client
migrations/          versioned and reversible
test/                unit/  integration/  concurrency/  load/
```

| Layer | May import | Why |
| --- | --- | --- |
| `domain` | itself | Financial rules are testable with no framework or database |
| `application` | `domain`, its own ports | Use cases stay independent of the transport and the ORM |
| `infrastructure` | anything | Adapters are where frameworks belong |
| `platform` | no business code | Plumbing stays reusable, and no rule hides there |

Not every clean-architecture layer earns its place. There are ports only where a real boundary exists, no generic repository, no command bus, and no CQRS.

## Domain model

Classes have private constructors, static factories, and `rehydrate` factories that do not re-validate transitions. Nothing here imports a framework.

```ts
class Money {
  static from(props: MoneyProps): Money;        // strict contract parsing, rejects negatives (FR-01)
  static zero(currency: string): Money;
  add(other: Money): Money;
  subtract(other: Money): Money;
  negate(): Money;                              // may be negative internally (FR-04)
  isZero(): boolean; isPositive(): boolean; isNegative(): boolean;
  isLessThan(other: Money): boolean;
  equals(other: Money): boolean;
  toJSON(): MoneyProps;
}

class Wallet {
  static open(props: OpenWalletProps): { wallet: Wallet; entry?: WalletLedgerEntry; opening?: WagerTransaction };
  static rehydrate(state: WalletState): Wallet;
  debit(money: Money, transactionId: string, at: Date): WalletLedgerEntry;   // raises on insufficient funds
  credit(money: Money, transactionId: string, at: Date): WalletLedgerEntry;
  canDebit(money: Money): boolean;
}

class WagerTransaction {
  static create(props: CreateWagerTransactionProps): WagerTransaction;
  static rehydrate(state: WagerTransactionState): WagerTransaction;
  markProcessed(referenceTransactionId: string | undefined, balance: Money, at: Date): void;
  markPendingReference(balance: Money): void;
  reject(code: RejectionCode, balance: Money | undefined): void;
  fail(code: FailureCode): void;
  isTerminal(): boolean;
  affectsBalance(): boolean;
  requiresReference(): boolean;
  matchesPayload(payloadHash: string): boolean;
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection;
}

class WalletLedgerEntry {                       // no mutable fields, no transitions
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry;
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry;
  isBalanced(): boolean;
}

/** Pure decision: the settlement order in REQUIREMENTS section 3.5, with no I/O. */
class SettlementPolicy {
  decide(input: {
    transaction: WagerTransaction;
    wallet: Wallet;
    reference: WagerTransaction | undefined;
    referenceAlreadyReversed: boolean;
  }): SettlementDecision;
}

type SettlementDecision =
  | { outcome: "apply"; direction: LedgerDirection | undefined; reference?: WagerTransaction }
  | { outcome: "reject"; code: RejectionCode }
  | { outcome: "wait-reference" };
```

**A rejection is a value, not an exception.** It must commit along with its inbox row and event. An exception would invite a rollback, and the rejection would vanish. Exceptions are for programming errors and infrastructure failures, which should roll back.

## Ports

```ts
interface UnitOfWork {
  /** Every repository is reachable only from inside, so a write outside the transaction cannot be written. */
  run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T>;
}

interface TransactionContext {
  wallets: { lockById(id: string): Promise<Wallet | undefined>; save(wallet: Wallet): Promise<void>;
             insert(wallet: Wallet): Promise<void> };
  transactions: { findByKey(key: string): Promise<WagerTransaction | undefined>;
                  findByExternalId(providerId: string, externalId: string): Promise<WagerTransaction | undefined>;
                  isReversed(referenceId: string): Promise<boolean>;
                  insert(transaction: WagerTransaction): Promise<void>;
                  update(transaction: WagerTransaction): Promise<void> };
  ledger: { append(entry: WalletLedgerEntry): Promise<void> };          // append only (FR-14)
  inbox: { record(message: InboxMessage): Promise<"new" | "duplicate" | "payload-conflict"> };
  outbox: { enqueue(events: IntegrationEvent<unknown>[]): Promise<void> };
}

interface EventPublisher { publish(message: OutboxMessage): Promise<void>; }
interface Clock { now(): Date; }
interface IdGenerator { next(): string; }       // UUIDv7, time-ordered for index locality
```

## Flows

### Settling a transaction

HTTP, SQS and the reference worker share this. **The order is the requirement**: code with the steps swapped looks the same and fails only under load.

```text
outside any transaction
  validate payload, compute hash (SR-04, FR-51)
  lock-free read by key: terminal row → replay or conflict (FR-52, FR-53)

BEGIN
  1. inbox insert ON CONFLICT DO NOTHING, SQS only (NFR-04)
     duplicate → commit and ack
  2. SELECT wallet FOR UPDATE, before any insert that references it (ADR-0003)
     missing → roll back, WALLET_NOT_FOUND
  3. re-read by key and by external id: replay or conflict (FR-52, FR-53, FR-54)
  4. resolve the reference, inside this lock (FR-21)
  5. SettlementPolicy.decide: section 3.5 of the requirements
  6. apply: wallet + ledger + transaction + outbox
     reject: transaction + outbox     (FR-25, FR-55)
     wait:   transaction + outbox     (FR-40)
COMMIT
after commit: respond, or ack (NFR-04)
```

A unique violation in step 6 means a race on the same key from another wallet path. The flow restarts once and finds the winner's row (ADR-0005).

### Publishing events

```text
BEGIN
  SELECT due rows FOR UPDATE SKIP LOCKED LIMIT n
  next_attempt_at = now + lease; attempts + 1
COMMIT
publish each, outside the transaction      (crash here: lease expires, another instance retries)
mark published                             (crash here: duplicate, safe through eventId, IR-03)
```

### Retrying a pending reference

The same claim pattern on `PENDING_REFERENCE` rows with a due `next_retry_at`, then the settlement flow from step 2. Expiry rejects with `REFERENCE_NOT_FOUND` (FR-42).

### Consumer classification

Outcomes are in REQUIREMENTS section 3.11. `SIGTERM` stops polling, finishes in-flight messages within `SHUTDOWN_TIMEOUT_MS`, returns visibility for the rest and fails readiness (FR-80). Compose's `stop_grace_period` is longer than that timeout, so Docker does not kill a draining instance.

## Schema

The schema enforces what must hold even if the code is wrong (NFR-02). Designed, not yet migrated.

| Table | Guarantees in the database |
| --- | --- |
| `wallets` | `UNIQUE (player_id, currency)`, `CHECK (balance >= 0)`, `numeric(20,2)`, `CHECK (version >= 1)` |
| `wager_transactions` | `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)`, reference required for `REFUND`/`ROLLBACK`, partial `UNIQUE (reference_transaction_id)` for processed reversals, partial index on due retries |
| `wallet_ledger_entries` | `UNIQUE (transaction_id)`, `UNIQUE (wallet_id, wallet_version)`, `CHECK (amount > 0)`, `CHECK` on before/after arithmetic, triggers rejecting `UPDATE`, `DELETE`, `TRUNCATE` |
| `inbox_messages` | `PRIMARY KEY (consumer_name, message_id)` |
| `outbox_messages` | Partial index on unpublished rows by `next_attempt_at` |

`wallet_version` on the ledger gives a stable order per wallet, the opaque cursor, and one more barrier: two entries cannot claim the same version.

**What no constraint covers:** that a balance change has a ledger entry. That holds because both happen in one use case, and reconciliation detects a breach (FR-70).

## Decisions the challenge asks to justify

| Topic | Choice | Record |
| --- | --- | --- |
| ORM | MikroORM with separate persistence records | [ADR-0002](docs/adr/0002-persistence-records-are-separate-from-domain-classes.md) |
| `Money` mapping | `bigint` minor units, `numeric(20,2)` in the database | [ADR-0004](docs/adr/0004-money-is-bigint-minor-units.md) |
| Transaction and concurrency | Row lock per wallet, before any insert | [ADR-0003](docs/adr/0003-wallet-row-lock-is-taken-before-any-insert.md) |
| Idempotency | Two unique keys and a stored result | [ADR-0005](docs/adr/0005-idempotency-is-enforced-by-two-unique-keys.md) |
| Reversals | One processed reversal per reference | [ADR-0006](docs/adr/0006-one-processed-reversal-per-reference.md) |
| Outbox | Lease claim | [ADR-0007](docs/adr/0007-outbox-claims-with-a-lease.md) |
| Authentication | Not implemented, extension point documented | [ADR-0009](docs/adr/0009-authentication-is-a-documented-extension-point.md) |

## Known limitations

- **No authentication.** Anyone reaching the API can act as any provider (T-06). Do not expose it.
- **Throughput per wallet is serial** by design, and bounded by settlement time.
- **Late `BET` after an expired `ROLLBACK`** is applied, with no tombstone (REQUIREMENTS section 3.6).
- **`REFUND`, `ROLLBACK` of it, then `ROLLBACK` of the `BET`** is refused and needs an operator (ADR-0006).
- **Emulator, not AWS:** contract tests cover the SQS behaviour relied on, and do not prove parity with AWS (ADR-0008).

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Base: tooling, CI, platform, runtime contracts, documents | In review |
| 1 | Domain: `Money`, `Wallet`, `WagerTransaction`, ledger, `SettlementPolicy` | Not started |
| 2 | Schema: migrations, constraints, triggers | Not started |
| 3 | Settlement use case and HTTP API | Not started |
| 4 | SQS consumer, inbox, DLQ, shutdown | Not started |
| 5 | Outbox and publisher | Not started |
| 6 | Out-of-order references worker | Not started |
| 7 | Reconciliation and observability | Not started |
| 8 | Multi-process failure suite (challenge §13) | Not started |
| 9 | Final documents, optional load test, release | Not started |
