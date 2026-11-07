# Architecture

How `wagering-processor` is built, and why. Rules live in [`REQUIREMENTS.md`](REQUIREMENTS.md), threats in [`THREAT-MODEL.md`](THREAT-MODEL.md), contested decisions in [`docs/adr/`](docs/adr/README.md).

> **Status: v1.1.1.** Every section below describes code that exists and is tested; where something is a judgement rather than a measurement, or is not provided, it says so, and the [limitations](#known-limitations) are in one place.

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
    infrastructure/  http/  messaging/  metrics/  persistence/  (adapters and the module that wires them)
  platform/          config, logging, metrics, health, database, lifecycle (drain, polling worker),
                     resilience (backoff), SQS client
  app.ts  app.module.ts  main.ts     the composition root
migrations/          versioned and reversible
test/                unit/  integration/  concurrency/  load/  support/
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
  equals(other: Money): boolean;                // false across currencies; ordering and arithmetic raise
  fitsStorage(): boolean;                       // a sum of valid amounts can outgrow numeric(20,2) (FR-05)
  toJSON(): MoneyProps;
  toString(): string;
}

class Wallet {                                  // implemented
  /** version starts at 1 and the opening does not raise it (FR-13). A zero opening records no entry (FR-12). */
  static open(props: OpenWalletProps): { wallet: Wallet; openingEntry: WalletLedgerEntry | undefined };
  static rehydrate(state: WalletState): Wallet; // does not re-validate
  /** Each change returns its ledger entry, built before the state changes: a refusal leaves the wallet untouched. */
  debit(money: Money, movement: Movement): WalletLedgerEntry;   // InsufficientFundsError
  credit(money: Money, movement: Movement): WalletLedgerEntry;  // BalanceLimitExceededError
  canDebit(money: Money): boolean;              // lets a policy reject with a code instead of catching
  canCredit(money: Money): boolean;
}
// Movement = { transactionId, entryId, at }: ids come from outside, so the domain stays deterministic.
// The OPENING WagerTransaction belongs to the use case, which supplies its id; Wallet only records the entry.

class WagerTransaction {                        // implemented
  /** A provider's operation. Cannot make an OPENING and refuses the reserved provider id (FR-62). */
  static create(props: CreateWagerTransactionProps): WagerTransaction;
  /** The only way to make an OPENING. Its keys derive from the wallet, so a second one collides in the schema (INT-21). */
  static createOpening(props: CreateOpeningProps): WagerTransaction;
  static rehydrate(state: WagerTransactionState): WagerTransaction;   // any status, no validation
  // PENDING → PROCESSED | REJECTED | PENDING_REFERENCE | FAILED; PENDING_REFERENCE → PROCESSED | REJECTED | FAILED.
  // Each validates first and then changes state, so a refusal leaves it untouched.
  markProcessed(referenceTransactionId: string | undefined, balance: Money, at: Date): void;
  markPendingReference(balance: Money): void;
  reject(code: RejectionCode, balance: Money | undefined): void;   // balance absent for PLAYER_WALLET_MISMATCH (FR-58)
  fail(code: InfrastructureFailureCode): void;                      // SETTLEMENT_FAILED only (INT-20)
  isTerminal(): boolean;
  affectsBalance(): boolean;                    // kind level: false for LOSS
  requiresReference(): boolean;
  acceptsReference(reference: WagerTransaction): boolean;           // kind rules only; same wallet/round/amount are the policy's
  matchesPayload(payloadHash: string): boolean;
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection;   // a ROLLBACK inverts its reference
}
// The retry schedule of a PENDING_REFERENCE (attempts, next retry) is persistence's, not the domain's: it lives on the row. Expiry is the worker's decision (FR-42).

class WalletLedgerEntry {                       // implemented; frozen, no transitions, dates copied in and out
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry;  // validates the arithmetic
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry;     // does not: reconciliation must be able to load a bad row
  isBalanced(): boolean;                        // false for mixed currencies instead of throwing
  // also carries walletVersion: the version the entry produced (FR-15)
}

/**
 * Implemented as a pure function, not a class: it has no state and nothing to inject.
 * REQUIREMENTS section 3.5, steps 3 to 11. The order is the requirement, so the tests swap every pair
 * of adjacent checks and expect a failure.
 */
function decideSettlement(input: {
  transaction: WagerTransaction;
  wallet: Wallet;                               // loaded under its lock
  reference: WagerTransaction | undefined;      // looked up within the sender's own provider
  referenceAlreadyReversed: boolean;            // a PROCESSED reversal already points at it (ADR-0006)
}): SettlementDecision;

// Each variant carries what the transition needs, so the caller decides nothing.
type SettlementDecision =
  | { outcome: "apply"; direction: LedgerDirection | undefined; referenceTransactionId: string | undefined }
  | { outcome: "reject"; code: RejectionCode; observedBalance: Money | undefined }   // absent for PLAYER_WALLET_MISMATCH and CURRENCY_MISMATCH (FR-58)
  | { outcome: "wait-reference"; observedBalance: Money };
// REFERENCE_NOT_FOUND is never returned here: a missing reference waits, and only the worker rejects it, on expiry (FR-42).
```

**The inbox and the outbox are not domain classes** ([ADR-0013](docs/adr/0013-inbox-and-outbox-are-rows-not-domain-classes.md)). The challenge sketches `InboxMessage` and `OutboxMessage` (§6.5); here they are rows written by the use case, because every guarantee they carry (written with the effect, two deliveries waiting for each other, one publisher per row) is a property of the statement that writes or claims them, and an object would be a weaker copy of it. The integration event they store is a domain class.

**A rejection is a value, not an exception.** It must commit along with its inbox row and event. An exception would invite a rollback, and the rejection would vanish. Exceptions are for programming errors and infrastructure failures, which should roll back.

## Ports

In `application/ports.ts`. Each exists because a real boundary does, and each has one adapter.

```ts
interface UnitOfWork {
  /** Repositories exist only inside, so a write outside the transaction cannot be written. */
  run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T>;
}

interface TransactionContext {
  wallets: { lockById(id): Promise<Wallet | undefined>; insert(wallet); save(wallet) };
  transactions: { findByKey(key); findByExternalId(providerId, externalId); findById(id);
                  isReversed(referenceId); insert(transaction);
                  update(transaction);                    // the outcome of one that was waiting; ends its schedule
                  scheduleRetry(id, nextRetryAt) };       // when a waiting transaction is looked at next
  ledger: { append(entry) };                              // append only (FR-14)
  inbox: { record(message): Promise<{ inserted: true } | { inserted: false; payloadHash: string }> };
  outbox: { enqueue(events) };
}

// Reads with no lock:      TransactionReader, WalletReader, ReconciliationReader (one statement, one snapshot)
// Background work:         OutboxStore (claimDue, markPublished, reschedule), EventPublisher,
//                          PendingReferenceStore (claimDue)
// Making things visible:   DivergenceReporter, WageringMetrics (a no-op by default)
// Plumbing:                Clock, IdGenerator (UUIDv7, time-ordered for index locality)
```

## Flows

### Settling a transaction

HTTP, SQS and the reference worker share this. **The order is the requirement**: code with the steps swapped looks the same and fails only under load.

```text
outside any transaction
  validate payload, compute hash (SR-04, FR-51)
  lock-free read by key, then by the provider's id: a row found → replay or conflict (FR-52, FR-53, FR-54)

BEGIN
  1. inbox insert ON CONFLICT DO NOTHING, SQS only (NFR-04)
     already there, same hash → the stored transaction is the answer; other hash → MESSAGE_ID_CONFLICT
  2. SELECT wallet FOR UPDATE, before any insert that references it (ADR-0003)
     missing → roll back, WALLET_NOT_FOUND
  3. re-read by key and by external id: replay or conflict (FR-52, FR-53, FR-54)
  4. resolve the reference, inside this lock (FR-21)
  5. decideSettlement: section 3.5 of the requirements
  6. apply: wallet + ledger + transaction + outbox
     reject: transaction + outbox     (FR-25, FR-55)
     wait:   transaction + outbox     (FR-40)
COMMIT
after commit: respond, or ack (NFR-04)
```

A unique violation in step 6 means a race on the same key from another wallet path. The flow restarts once and finds the winner's row (ADR-0005).

**The two reads are not one snapshot, and the code asks what a row is, not which read found it.** A twin can commit between the lookup by key and the lookup by the provider's id. The first then misses and the second finds the twin's row, which carries *our* key. The first version read that as "this operation exists under another key" and answered `EXTERNAL_ID_CONFLICT` to a request that was a plain replay: 13 of 600 identical requests, in 8 of 12 rounds of fifty spread over three processes. It never showed up in a single process, and it was found by the check that uses three. A row under our own key is a replay (or a key conflict, if the payload differs) however it was reached; only a row under another key is the id conflict. A test makes a twin commit in exactly that gap.

**Implemented** in `SubmitWagerTransaction`, including the inbox step, which runs only when a `MessageSource` is given. `outbox_messages` is written in the same transaction, and the publisher sends it after the commit.

**The inbox step and what it is for.** It is the first statement of the locking transaction and references no wallet, so it needs no lock. A second delivery of the same message waits for the first to finish (the primary key is the lock), then finds the row and answers with the stored transaction. Redelivery is mostly already absorbed by the idempotency key, and that fast path runs first; the inbox adds what the key cannot: **a message id reused with other content is detected** (`MESSAGE_ID_CONFLICT`, dead-letter, INT-17), and the challenge's required record that a message was seen. A new message id with a known key is a replay and is not recorded. The row is written together with the effect and rolls back with it, which the tests show by crashing after each write: no row survives, so the redelivery is not taken for a duplicate and acknowledged with nothing done.

### Lock limits

- **`LOCK_TIMEOUT_MS`, default 2000.** Measured on a laptop with local Docker (median of 5 runs, a rough figure and not a benchmark): 40 parallel operations on one wallet finish in about 169 ms, so about 4 ms each, fast path included. Two seconds therefore means roughly 470 operations are already queued on one wallet. Waiting longer holds a pooled connection for an answer the provider may have stopped waiting for, so past that point the system answers "try again" and sheds the load. It is a judgement, not a measured optimum: the load test should revisit it (ADR-0003).
- **`STATEMENT_TIMEOUT_MS`, default 5000.** The upper bound on any statement, lock wait included, so a hung query cannot hold a connection forever (NFR-11). It is longer than the lock limit so the lock limit answers first, with its own code.
- Both are `SET LOCAL`: they end with the transaction and do not leak to the connection's next user, which a test checks.
- **What is transient:** `55P03`, `40P01`, `40001`, `57014`, the shutdown and connection classes, and network errors. Nothing was committed, so trying again is safe. A constraint violation is not: retrying cannot change its answer, so it stays loud. Only a violation of the two operation keys restarts the flow.

### Connection pool

A request needs a connection for as long as it holds a lock, and a lock can be waited on, so the pool is where a burst on one wallet turns into a problem for every other wallet. It is bounded on both sides (NFR-11).

- **`DATABASE_POOL_MAX`, default 10 per process.** PostgreSQL allows 100 connections by default, so three processes at 10 use 30 and leave room for migrations, monitoring and more instances. More is not faster: a settlement takes about 4 ms, so ten connections already sustain far more than one hot wallet can use, because that wallet's operations are serial whatever the pool holds. Extra connections would only seat more waiters on the same lock, holding connections other wallets need.
- **`DATABASE_ACQUIRE_TIMEOUT_MS`, default 1000.** How long a request waits for a free connection before giving up as a transient failure. Without it a request behind a full pool waits without bound. It is shorter than the lock limit on purpose, so a request that cannot even get a connection answers sooner than one already waiting on a lock.
- **The worst case for one request** is therefore about the acquire wait plus the lock wait plus its own work, a little over three seconds at the defaults, and it ends as a `503` with `Retry-After` and not as a hang.
- **A full pool is told apart from a lock timeout** in the log (`no database connection became free` against `55P03`), and both are warnings: the system is shedding load as designed.
- **The pool's error is recognised by its message,** because `pg-pool` raises a bare `Error` with no code. A test provokes the real one, so an upgrade that rewords it fails there and not silently in production.
- **So is a connection that could not be opened in time, or was closed:** the client reports `Connection terminated due to connection timeout` (opening one took longer than `DATABASE_ACQUIRE_TIMEOUT_MS`, which also bounds opening) and `Connection terminated unexpectedly`, again with no code. **The failure suite found this on the CI runner:** under 90 concurrent requests on two cores, opening new connections took over a second, and the unrecognised error was a `500` that no provider would retry. It is a `503` now. A test provokes it with a server that accepts the connection and never answers.
- **What the burst test proves:** with four connections, a 200 ms connection wait and a 300 ms lock wait, a burst on a locked wallet ends every request as applied, rejected or `503`, never a `500` and never a hang. At most four requests ever waited on the lock, which is what shows the pool is the cap. Retrying everything with the same keys then applies each exactly once.
- **Measured once, briefly** (`bun run test:load`, [`docs/LOAD-TEST.md`](docs/LOAD-TEST.md)): with 64 callers on one wallet the slowest answer was 1.8 s against the 2 s lock timeout and nothing timed out; with 256 callers 3.1 % were `503` from the pool, with no lock timeout. The defaults held under that load, the margin of the lock timeout was small, and sustained load was not tried.

### Publishing events

```text
BEGIN
  SELECT due rows FOR UPDATE SKIP LOCKED LIMIT n
  next_attempt_at = now + lease; attempts + 1
COMMIT
publish each, outside the transaction      (crash here: lease expires, another instance retries)
mark published                             (crash here: duplicate, safe through eventId, IR-03)
```

**Implemented** as `PublishOutbox` (application) over two ports, `OutboxStore` and `EventPublisher`, with `MikroOrmOutboxStore`, `SqsEventPublisher` and a worker loop in the `publisher` role.

- **The claim is one statement,** `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED LIMIT n)`, so selecting and leasing cannot be pulled apart. `SKIP LOCKED` makes a publisher pass over rows another is claiming at that moment instead of waiting. The lease is `next_attempt_at = now + OUTBOX_LEASE_MS` and `attempts + 1`. Nothing is held while publishing, so a slow broker costs no connection (the alternative ADR-0007 rejected).
- **Failure puts back the failed row and the rest of the batch, and stops.** If the broker is away each try would wait out its own timeout while the leases of the others run down, so the round ends at the first failure and the unattempted rows go back with the same backoff. That also keeps a wallet's events in the order they were claimed. The delay is `backoffSeconds(attempts)` (base `OUTBOX_RETRY_BASE_SECONDS`, cap `OUTBOX_RETRY_CAP_SECONDS`) with jitter, and there is **no attempt limit** (FR-91): an event is only ever delayed.
- **Marking is conditional** (`published_at is null`), so a publisher that is late after its lease ran out changes nothing.
- **Sending is bounded** (5 s per call, NFR-11). A round is at most one timeout long on failure, which is far inside the 30 s lease. A lease shorter than a slow publish causes a duplicate, which IR-03 accepts.
- **The broker's own deduplication is an optimization.** `MessageDeduplicationId` is the outbox row's id (which is the `eventId`), so a repeat inside five minutes is dropped. After that window, or on another broker, a repeat arrives, and the consumer's `eventId` check is what holds (IR-03, NFR-05). The test asserts the repeat carries the same `eventId`.
- **Order is not guaranteed across retries.** FIFO keeps a wallet's events in send order, but a retry can send an earlier event after a later one that was already out. `walletVersion` in `WalletBalanceChanged` is how a consumer restores the order.
- **Stopping** waits for the round in progress (bounded by the send timeout), so what it claimed is published or put back and not left to its lease (FR-81).
- **Sent in batches, over lanes.** A round claims `OUTBOX_BATCH_SIZE` rows (100) and sends them with `SendMessageBatch`, ten to a call. `planLanes` lays the claimed events out so that **a wallet's events are in one lane, in the order they were claimed**; lanes are sent at the same time (`OUTBOX_PUBLISH_CONCURRENCY`, 1 by default), calls within a lane one after the other, so two events of one wallet are never in flight together. The marking and the putting back are one statement each, not one per row.
- **When the broker refuses or fails.** An entry the broker refuses is put back, and so are the events of its wallet in the later calls of the lane, which are not sent past it. The events of the same call that the broker took cannot be taken back, so an event refused in a call arrives after the ones that followed it in that call: a reorder within a call, which `walletVersion` and IR-03 already allow for. A call that fails as a whole puts back its entries and the rest of its lane; the other lanes go on.
- **Measured, and still the weak point** ([`docs/LOAD-TEST.md`](docs/LOAD-TEST.md)): batching lifted a publisher alone from 137 to 185 events per second, and four to eight lanes to 230 to 300. But the emulator handles requests one after another, so parallel calls take proportionally longer, and in the full load test more lanes cost the hot wallet's settlement latency (p50 from about 50 ms to about 600 ms). That is why the default is one lane. Three publishers still empty a backlog at 130 to 250 events per second against about 900 produced at the spread rate, so a sustained rate above roughly 65 to 125 bets per second grows the lag without bound. Real SQS was not measured. `LISTEN/NOTIFY` as a wake-up, the reopening criterion of ADR-0007 for latency, is not done.

### Retrying a pending reference

```text
claim (one statement):  PENDING_REFERENCE, next_retry_at <= now, oldest first, FOR UPDATE SKIP LOCKED
                        next_retry_at = now + lease; retry_attempts + 1
per transaction, in its own SQL transaction:
  SELECT wallet FOR UPDATE                      (ADR-0003)
  re-read the transaction; no longer waiting -> skip
  resolve the reference, decideSettlement       (the same pure function as a first arrival)
  apply / reject -> UPDATE the row, ledger, wallet, outbox
  wait, TTL not passed -> next_retry_at = now + backoff
  wait, TTL passed -> reject REFERENCE_NOT_FOUND (FR-42)
  error that is not transient -> FAILED, SETTLEMENT_FAILED (FR-32)
```

**Implemented** as `SettleWaitingReferences` over `PendingReferenceStore`, with the effects of an ending shared with a first arrival in `applyOutcome` (`insert` or `update` is the only difference), so the two cannot drift apart. `PollingWorker` in the platform runs it and the outbox publisher alike.

- **The schedule is on the row** and is enforced by a check (`ck_wager_transactions_retry_only_while_waiting`), so it cannot outlive the wait. A transaction that first waits gets `next_retry_at` in the same SQL transaction as its insert.
- **Nothing triggers a look when the reference arrives.** A reversal that is waiting is settled at its next look, within the backoff (5 s first, then doubling to 5 min). That is the specified behaviour and not an oversight: the alternative, settling waiting reversals from the settlement of their reference, couples two transactions under two wallet locks' ordering and was not needed. The cost is a reversal that waits up to the current backoff after its bet arrives.
- **Oldest first** matters for chains: a reversal waiting on another reversal is always the younger, so within one round the older settles first and the younger finds it processed. If the older cannot settle, the younger keeps waiting (FR-47). If the older expires and is rejected, the younger is rejected `REFERENCE_NOT_PROCESSED` at its next look, which is the specified answer for a reference that was rejected.
- **The wallet lock is taken before the re-read,** so by the time the status is checked nothing else is settling that wallet, and a transaction settled in the gap is skipped.
- **A transient failure leaves the row as it is.** The lease it holds is its retry, and `retry_attempts` counts the claim.
- **Not measured:** how many waiting rows a worker clears per second. A round is 25 transactions, each its own SQL transaction.

### Consumer

`WagerQueueConsumer` (`infrastructure/messaging`) long-polls `wager-transactions.fifo`, parses each message with `parseWagerMessage`, which reuses the HTTP field validation (SR-02), and calls `SubmitWagerTransaction.execute(command, { consumerName, messageId })`. The message id is the correlation and causation id of its events. A message is deleted only after `execute` returned, that is after `COMMIT` (FR-78). A batch is handled in order, and a failure blocks the rest of that wallet's messages in the batch (FR-79).

- **Stopping waits for the poll in progress and does not cancel it.** A cancelled long poll stays open at the broker, which delivers the next message to a connection nobody reads and hides it for the visibility timeout (30 s). It was observed on the emulator, and it took messages from the tests that followed, which is how it was found. The alternative, aborting for a fast exit, was rejected for that reason. The cost is that stopping takes up to `QUEUE_WAIT_SECONDS` (default 5, at most 20).
- **Failures.** A permanent failure (REQUIREMENTS 3.11) is copied to the DLQ at its first delivery and deleted, and does not hold its wallet. A transient or unrecognised one has its visibility set to `backoffSeconds(receiveCount)` (FR-82): the ceiling is `base * 2^(n-1)` capped, and the delay is drawn from its upper half, so a retry is never immediate and a crowd that failed together is spread out. On the fifth delivery it is copied to the DLQ as `attempts-exhausted`. The copy comes before the delete, so a crash between them leaves a duplicate in the DLQ (its deduplication id is the message id) and never a lost message; if the copy fails the message stays in the queue and is delivered again. The DLQ message carries the body unchanged and the reason as attributes, so it can be put back as it is.
- **The cost of the bound, and the gate that spares it an outage (FR-101).** Five deliveries with the default backoff span roughly 15 to 30 seconds, so a database that stayed away longer would have dead-lettered what was waiting. Before every receive the consumer runs the probe readiness reports as `postgres` (`select 1`, two seconds at most); while it fails nothing is received, so no delivery is spent, and it logs once when it stops and once when it resumes. What is not covered: the batch already in hand when the database goes away still fails and spends one delivery; a probe that says "up" while settlement fails (a lock, a constraint, a bug) gates nothing, and the limit ends that message in the DLQ as before; and a probe that times out on a saturated pool pauses receiving for a second, no more. The gate is tested with PostgreSQL really stopped for twice the time the five deliveries need. It does not cover an outage of the broker, which the receive loop already waits out. The bound itself, `QUEUE_BACKOFF_CAP_SECONDS` and `MAX_RECEIVE_COUNT` (the latter provisioned with the queue), stays a judgement, not measured.
- **Shutdown.** The message in hand finishes; the rest of the batch is returned with visibility 0 (see Graceful shutdown). If returning fails, the visibility timeout does it later.
- **A FIFO group is held by an unacknowledged message,** so one failing message delays its wallet's later messages for the visibility timeout (T-10).

### Consumer classification

Outcomes are in REQUIREMENTS section 3.11. `classifyFailure` is a pure function: transient failures retry; invalid, unknown, conflicting or wallet-less messages are dead-lettered; anything unrecognised retries, because a bug fixed by a deploy should find its messages still in the queue. `SIGTERM` stops polling, finishes in-flight messages within `SHUTDOWN_TIMEOUT_MS`, returns visibility for the rest and fails readiness (FR-80). Compose's `stop_grace_period` is longer than that timeout, so Docker does not kill a draining instance.

## HTTP API

The contract in machine-readable form is `docs/openapi.yaml` (OpenAPI 3.1). It is not generated from the code, which would make it true by construction and hide a wrong status; it is written by hand and checked against the running application by `test/integration/openapi.test.ts`: the set of routes, the examples against their schemas, and each real answer (every status that can be provoked without breaking a dependency) against the schema declared for it. The `503` and `500` responses need a failing dependency and are asserted in the suites that break one. The spec also validates under kin-openapi, the library the security scanner uses to import it.

Implemented: the wallet endpoints, `POST /wagering/transactions`, and the two reads of a transaction (`GET /wagering/transactions/:transactionId` and `GET /providers/:providerId/wagering/transactions/:externalTransactionId`).

- **Controllers are thin:** parse, call one use case, shape the answer. Parsing is by hand and collects every problem before refusing, so a provider fixes a request in one round trip. There is no validation library, because the shapes are small.
- **`OpenWallet`** is one SQL transaction: the wallet first (the others point at it), then the `OPENING` transaction, its ledger entry and the events (FR-11). The unique index on player and currency decides a race, so 20 creations at once give one wallet and 19 conflicts.
- **`QueryWallets`** reads through a `WalletReader` port that takes no lock (FR-67). The ledger is ordered by `wallet_version`, which is unique within a wallet and only grows, so a page is a range scan on `uq_ledger_wallet_version` and the cursor can mean "after version N".
- **`SubmitWagerTransaction`** is the use case behind `POST /wagering/transactions`, and the SQS consumer calls the same one (§10). The `Idempotency-Key` header is the source of truth (FR-50), the response status follows the outcome (200, 202 or 422), and a replay has the status of the original.
- **The edge repeats rules the domain also holds** (kind, a zero amount, the reference), so a provider is told which field to fix. A test checks that the two never disagree.
- **Provider ids and keys are opaque but bounded:** 255 characters, no control characters. A NUL would otherwise reach PostgreSQL and come back as a `500`.
- **`ProviderAuthGuard` lets every request through** and is attached to every business controller (ADR-0009). A test finds the controllers in the source and fails if one lacks it or is unregistered, so the real check, when it exists, replaces one class and nothing else.
- **A stored `FAILED` transaction is a `500`,** not a `503`: it is terminal, so asking again returns the same answer. It is set by the reference worker on an error that is not transient (FR-32), and is otherwise reachable only by a row inserted directly.
- **The cursor is opaque, not secret or signed.** Editing it starts from another place in the same wallet's ledger, which anyone could read from the start.
- **Errors** are one envelope and one mapping, applied by a filter and by a middleware after the body parser ([ADR-0012](docs/adr/0012-errors-are-one-envelope-with-one-mapping.md)).
- **Composition:** `src/app.ts` builds the application for `main` and for the tests alike, and `AppModule.register(config)` is the one place that knows both platform and business code. Entities and roles are passed in, because `platform` may not import business code.

## Schema

The schema enforces what must hold even if the code is wrong (NFR-02). It is in `migrations/`, and every constraint below has a test in raw SQL that asserts which constraint refused the row. Triggers add what a constraint cannot express: the ledger refuses `UPDATE`, `DELETE` and `TRUNCATE`, and a terminal transaction refuses `UPDATE` and `DELETE`.

| Table | Guarantees in the database |
| --- | --- |
| `wallets` | `UNIQUE (player_id, currency)`; `balance >= 0`, in `numeric(20,2)`; `version >= 1`; currency shape |
| `wager_transactions` | `UNIQUE (idempotency_key)`; `UNIQUE (provider_id, external_transaction_id)`; partial `UNIQUE (reference_transaction_id)` for processed reversals; a reference in the same wallet (composite foreign key); reference required for `REFUND`/`ROLLBACK` and refused on `BET`/`OPENING`; only `LOSS` may be zero; `OPENING` if and only if the provider is `internal`; a failure code exactly when the status calls for one, from the known list; `processed_at` exactly when `PROCESSED`; a balance on `PROCESSED` and `PENDING_REFERENCE`; a reference link exactly when processed with a declared reference; a retry schedule only while `PENDING_REFERENCE` |
| `wallet_ledger_entries` | `UNIQUE (transaction_id)`; `UNIQUE (wallet_id, wallet_version)`; before/after arithmetic, which also refuses any other direction; `amount > 0`; non-negative balances; the wallet's currency and the transaction's wallet (composite foreign keys) |
| `inbox_messages` | `PRIMARY KEY (consumer_name, message_id)` |
| `outbox_messages` | Event id as primary key; `attempts >= 0`; partial index on unpublished rows by `next_attempt_at` |

`wallet_version` on the ledger gives a stable order per wallet, the opaque cursor, and one more barrier: two entries cannot claim the same version.

### Records and mappers

Persistence is in `infrastructure/persistence` (ADR-0002): `records.ts` holds the shape of each table as plain data, `schemas.ts` maps them with `EntitySchema`, and `mappers.ts` converts to and from the domain. Nothing above infrastructure imports any of it.

- **Amounts are strings in a record and `Money` in the domain.** The ORM reads `numeric(20,2)` as an exact string, and the mapper builds `Money` from it. A stored amount that is not two decimals is an error and is never repaired.
- **A stored kind, status, direction or failure code that the code does not know is an error** (`PersistenceMappingError`), because the CHECKs make it unreachable unless the schema and the code have drifted.
- **`updated_at` belongs to persistence.** The domain's transaction has no such field, so the writer supplies it.
- **A ledger entry loads without being re-validated,** so a corrupt stored row still loads and reports itself unbalanced for reconciliation (FR-70).
- **The mapping cannot drift from the migrations unnoticed:** a test compares every column's data type and nullability with the declared runtime type, and the columns with the record's keys.
- `createOrmConfig` takes the entities as a parameter, because `platform` may not import business code.

**What no constraint covers:**

- That a balance change has a ledger entry, or that an entry's amount equals its transaction's. Both hold because they happen in one use case, and reconciliation detects a breach of the first (FR-70).
- A role that owns the table, or a superuser, disabling a trigger (T-09). In Compose the application connects as a superuser, so the triggers stop mistakes, not a hostile operator; a deployment needs a separate role that does not own the tables.
- A third decimal. `numeric(20,2)` **rounds** on input rather than refusing, and a test pins that. `Money` is what refuses it (FR-01), which is why nothing else may write amounts.
- A new failure code needs a migration, because the known list is in a `CHECK`. That is deliberate: the taxonomy is a contract with providers.

**A lesson for later constraints:** a `CHECK` passes when its expression is `NULL`. A rejection with no failure code was accepted until the check used `coalesce`, so anything comparing a nullable column must say what `NULL` means.

`wager_transactions` also carries the retry schedule of a waiting transaction (`retry_attempts`, `next_retry_at`), added by its own migration with a check (`ck_wager_transactions_retry_only_while_waiting`) that keeps the schedule from outliving the wait, and a partial index on the due ones.

## Patterns

Each pattern is here because a stated failure needs it. Where one does not fit, the reason is recorded.

### Idempotency and duplicate control

A duplicate is stopped at several independent layers, so no single one has to be perfect. Only the database layers are guarantees (NFR-05).

| Layer | Stops | Kind |
| --- | --- | --- |
| SQS `MessageDeduplicationId` | Same message within the broker's window | Optimization |
| Inbox `(consumer_name, message_id)` | Redelivery of one message | Guarantee |
| `UNIQUE (idempotency_key)` with payload hash | Same operation by any channel; a changed payload is a conflict | Guarantee |
| `UNIQUE (provider_id, external_transaction_id)` | Same provider operation under another key | Guarantee |
| `UNIQUE (transaction_id)` on the ledger | A second entry for one transaction | Guarantee |
| Partial unique index on reversals | A second reversal of one reference | Guarantee |
| `eventId` | Duplicate publication | Consumer's duty (IR-03) |

### Consistency

- **Strong inside a wallet:** one SQL transaction holds the inbox, the transaction, the balance, the ledger and the outbox (NFR-04).
- **Eventual outside it:** events arrive after commit, at least once, and may reorder, so they carry `walletVersion`.
- **Detected, not assumed:** reconciliation compares the balance with the ledger and never corrects it (FR-72).

### Observability

`WageringMetrics` is a port in the application layer (`NO_METRICS` by default), implemented by `PrometheusMetrics` on the registry `/metrics` serves. Each method is a fact that already happened and returns nothing: a metric never decides, and one that fails must not fail what it measures. The settlement use case counts a decision or a replay after the fact and times itself; the consumer counts retries and dead letters; the outbox and the reference worker count what they put back; the unit of work reports every transient database failure through `onTransientFailure`, which is how lock conflicts are counted wherever they happen, reads and workers included.

- **Lock conflicts need a patient transaction to show a deadlock.** A lock timeout shorter than PostgreSQL's deadlock detection (1 s) ends a would-be deadlock as a lock timeout first. The test for the deadlock series uses transactions that wait longer; the default `LOCK_TIMEOUT_MS` of 2 s is above the detection time, so in production a real deadlock is reported as one.
- **Outbox lag is read when scraped,** by a query over the unpublished rows, and a failure to read keeps the last value instead of a zero that would read as "caught up". It costs a scan of the backlog (the partial index) per scrape per process.
- **Labels are a closed set.** `source`, `kind`, `status`, `reason` and `component` are enumerations. The wallet is not a label.
- **Logs.** Every settlement line carries the correlation id, the transaction, the wallet and the provider; the allowlist in `JsonLogger` is the last defence and a test is the first: it searches every line for values from the payload. A mutation that put a payload value in the message text, which the allowlist cannot see, was caught by that test.
- **Not provided:** tracing (OpenTelemetry is optional in the challenge), dashboards and alert rules. The cost of the settlement timer is one clock read at each end.

### Reconciliation

`ReconcileWallet` reads a `LedgerSnapshot` through `ReconciliationReader` and tells a `DivergenceReporter`. The reader is one SQL statement: the wallet row and every entry of the wallet in the same snapshot, with the sum of credits, the sum of debits, the count, and the entries that fail a check, found with a window function (`lag(balance_after)`). It takes no lock.

- **One statement is the consistency.** Reading the balance and then the ledger in two statements shows a balance the ledger has not caught up with whenever a settlement commits between them, and reports a divergence that is only a race. A test commits 80 bets while 60 checks run, and a variant with two reads fails it.
- **No lock, so it cannot hurt settlement,** and it is not a guard on it: a check that took the wallet lock would make an operator's curiosity a cause of latency on the wallet that matters most.
- **Never corrects.** Correcting would be deciding which of two numbers is the lie. A divergence is made visible three ways: in the response, as an error in the log naming the wallet, and in `wagering_reconciliations_total{result="divergent"}`. The counter has no wallet label (unbounded), and its `divergent` series exists from the start at zero, so an alert on its rate is never about an absent series.
- **What can actually diverge.** The schema refuses an entry that does not add up, an out-of-order version, an update or delete of the ledger, and a negative balance. Reconciliation therefore sees a wrong *balance* (an `UPDATE wallets` that bypassed the use case, a bug that saved without appending) as a difference, and a wrong *entry* only when someone removed a defence. The tests remove them on purpose (a trigger and a constraint dropped and restored afterwards), to show the check notices.
- **Cost.** It scans the wallet's whole ledger, a range scan on `uq_ledger_wallet_version`, bounded by the statement timeout. How many run at once is bounded per process (FR-102, T-16), which protects settlement and not the database as a whole. A wallet with millions of entries would want a checkpointed incremental check; that is not built, and not measured.
- **Not covered.** It does not compare the ledger with the transactions table (that an entry's amount equals its transaction's holds because both are written in one use case), and it detects nothing a superuser alters consistently (T-09).

### Resilience

| Failure | Response | Reference |
| --- | --- | --- |
| Transient database or lock failure on HTTP | `503` with `Retry-After`, nothing committed | NFR-11 |
| Transient failure on the queue | No ack, backoff through visibility, bounded by attempts | NFR-11 |
| Permanent failure on the queue | DLQ, kept for an operator | §10 |
| Broker down while publishing | Rows wait in the outbox and retry, with no attempt limit | FR-91 |
| Process death at any point | Unacked messages return, and leases expire | ADR-0007 |
| Hanging dependency | Every call has a timeout, and readiness reports it | NFR-11 |
| One role overloaded | Roles run as separate processes when needed | ADR-0001 |

**Retry and circuit breaker, deliberately different.** Retrying is safe only because of idempotency. A **circuit breaker does not fit** today: with PostgreSQL down no request can succeed anyway, it fails fast through `lock_timeout` and connection errors, and readiness already removes the instance from routing. Failing work on the queue already waits through visibility. A breaker would add state per instance to protect a dependency that has no fallback. Reopen if the load test shows requests piling up during an outage.

### The model-based test

`test/integration/settlement-model.test.ts` (issue #54) generates random sequences of `BET`, `WIN`, `LOSS`, `REFUND` and `ROLLBACK` on three wallets, with reversals sent before what they reverse, references that are the wrong kind, amount, round or wallet, duplicates resent exactly or under the same key with another amount, and the reference worker run in between. Each runs through the real use case and the real worker on PostgreSQL, and every answer (status, failure code, replay flag) and every balance is compared with a reference model of about sixty lines written from the table in REQUIREMENTS 3.3.1, not from the domain's code. Each sequence ends on `balance == ledger rebuild` for every wallet.

- **Seeded and repeatable.** 20 seeds by default (`MODEL_RUNS` for more), each 60 steps, about a second a seed. A failure prints its seed, the step and the steps so far, and `MODEL_SEED=<n> bun test test/integration/settlement-model.test.ts` repeats it. 600 seeds were run once and agreed with the model.
- **It asserts what it reached.** A last test fails unless the default seeds produced each outcome the model can (a processed and a rejected of each kind, each rejection code of the reference rules, a waiting reversal that later settled and one that later was refused, a replay of each status, a conflicting resend). The first version of the generator picked references at random and reached `REFUND PROCESSED` once and `ALREADY_REVERSED` almost never; this check is what showed it.
- **Mutation-tested.** Removing the one-reversal rule, the amount rule or the reference-kind rule (`bun run test:mutation`) fails the test on the first seed.
- **What it does not cover.** One provider, one currency, one player per wallet, so provider-scoped lookup and the currency and player checks are not varied; no concurrency (a sequence is serial; the multi-process suite does that); no expiry of a waiting reversal (the TTL is an hour and the clock is real); sweeps of the worker run one row at a time so a sweep's order is the order of arrival, which the model assumes (a larger batch settles its rows in no stated order, and two reversals competing for one reference could then go either way). The model is mine: if it and the domain were wrong the same way the test would not notice.

### The failure suite

`test/concurrency/multiprocess.test.ts` runs the eight mandatory scenarios of challenge §13 against **real application processes** (`bun run src/main.ts`, three or more at a time) sharing one PostgreSQL and one broker, and ends every test on the invariant `balance == the balance the ledger rebuilds` (never negative). In-process tests cannot show a kill, a restart or a second instance taking over, which is what these exist for.

| § | Scenario | How it is made deterministic |
| --- | --- | --- |
| 1 | the same bet 50 times at once, three processes | one request each, all started together; the answer is the same transaction every time |
| 2 | operations contending for one balance | the §8 pair on twelve wallets; thirty bets of 10.00 against 50.00 (exactly five apply) |
| 3 | different wallets at once | thirty wallets, three bets each |
| 4 | three processes, every role | HTTP, queue, duplicates and an early refund together; every event ends up published |
| 5 | worker killed after the commit and before the ack | the acknowledgement is **held at a proxy** in front of the real broker, so the process has committed and cannot have acknowledged; the test kills it there |
| 6 | publishers on one outbox | three publishers (each row claimed once); a publisher killed holding a claim, its send held at the proxy, and the survivors take over after the lease |
| 7 | reversal before its reference | two workers and a chain (rollback of a refund of a bet, all first); forty made due at the same instant for three workers |
| 8 | restart | eight wallets' locks are held by the test, so their requests are inside a transaction when all three processes are killed; new processes get every request again with the same keys |

**No sleeping to hope for a race.** A kill happens at a state the test has found: a held request at the proxy, a lock the test holds, a count it has waited for. The proxy forwards everything else to the real broker unchanged and rewrites queue urls so the client does not walk around it; it holds requests and nothing more.

**What was removed, once each, and seen red:** the wallet lock; the idempotency lookup; acknowledging before the use case runs; the outbox lease; marking before publishing (events lost when the publisher is killed). **`SKIP LOCKED` on the outbox and on the pending-reference claim were listed here too, and the repeatable run (`bun run test:mutation`) showed that no test, the multi-process scenarios included, noticed either gone.** Neither is what keeps two workers off one row: a worker that waited on the lock re-reads the row and finds it leased. It keeps them from waiting on each other, and a test now asserts that. One protection is not covered by a multi-process scenario: the re-read of a waiting transaction under the wallet lock only matters when a lease ran out and the row was claimed twice, which the in-process test builds deliberately; across processes the leases already keep claims exclusive.

**Not covered.** A process killed at an arbitrary instruction (the kill points are the ones above); a database that is killed rather than stopped (a stopped one is tested with the consumer); a clock that disagrees between hosts (the lease is the database's clock for the claim and the process's for the retry).

### Graceful shutdown

The order matters:

```text
SIGTERM
  1. readiness fails, so routing stops            (done, tested)
  2. stop polling / claiming                      (consumer, publisher, reference worker: done, tested)
  3. finish in-flight work, up to the deadline    (consumer: done, tested)
  4. return the visibility of the rest            (consumer: done, tested)
  5. close database and SQS clients               (done)
  deadline exceeded: exit 1; unacked work returns by itself   (done, tested)
```

**Readiness must fail before anything waits.** Nest runs the shutdown hooks of different modules one after another, so the consumer's hook, which waits for the message in hand, delayed the hook that flipped readiness: the first version of the test saw `/health/ready` answer 200 for as long as the message took. `DrainState` now lives in the platform and the consumer calls `begin` before it waits. The test failed on that before the fix.

**What the tests do.** They run the real entry point as a process, hold a wallet lock from the test so a message cannot finish for as long as the test wants, send three messages for three wallets, and signal. In the graceful case the lock is released after the signal: the message finishes and is deleted, the two that had not started are returned with visibility 0 (visible at once, not after 30 s), readiness reported `draining` meanwhile, and the exit code is 143. In the deadline case (`SHUTDOWN_TIMEOUT_MS=2000`) the lock is never released: the process exits 1 near the deadline, nothing is applied or deleted, and after the visibility timeout another worker settles all three exactly once.

**Not covered.** The deadline test needs the 30 s visibility timeout to pass, so it takes about 40 s. A `SIGKILL` is covered by the failure suite (a process killed at a held acknowledgement, a held publish and with all locks held), not by this test. The publisher and the reference worker are tested stopping as real processes (`outbox-publisher.test.ts`, `reference-worker.test.ts`), but while idle or between rounds, not in the middle of a settlement.

Shutdown is an optimization of recovery, not the guarantee. `kill -9` must also be safe, and the failure suite proves that.

### Events and the payload hash

Both are contracts with the outside, so each is pinned by a test. The hash vectors were computed with Python, a tool independent of this code. The event envelopes are pinned by the expected JSON written out in the test: that fixes the format, but it was written by hand and not computed.

- **Integration events** (`wagering-events.ts`) extend an abstract `IntegrationEvent<T>` whose `eventType` and `version` belong to the class. The payload is frozen and holds plain JSON only. Their shape is REQUIREMENTS section 3.12.1.
- **The payload hash** (`application/payload-hash.ts`) sits in `application` rather than `domain` because it needs `node:crypto` and the domain imports only itself. It is where HTTP and SQS converge, which is the reason it exists: the same operation must hash the same over both.

## Operating it

What an operator needs and the code does not do for them.

### Replaying the dead-letter queue

A message in `wager-transactions-dlq.fifo` carries its original body unchanged, and three attributes: `FailureKind` (`permanent` or `attempts-exhausted`), `FailureReason` (the error, in full, which can include the key and ids the sender sent) and `Receives`.

1. **Read the reason before replaying.** A `permanent` failure replayed unchanged fails the same way: fix the cause first (the wallet exists now, the payload was corrected upstream). An `attempts-exhausted` one usually needs only the dependency back.
2. **Send the body back to `wager-transactions.fifo`**, with the same `MessageGroupId` (the wallet id, so the wallet's order holds) and a **new `MessageDeduplicationId`**: within five minutes the broker drops a repeat of the old one.
3. **Replaying is safe however often it is done.** A dead-lettered message left no inbox row, because the transaction that would have written it rolled back, so the replay is settled normally; and if the operation was in fact applied by another path, the idempotency key answers it as a replay and changes nothing.
4. **Then delete it from the DLQ.**

There is no tool for this; it is a few calls of the SQS API. The broker's own redrive (`StartMessageMoveTask`) would do steps 2 and 4, where the broker supports it for FIFO queues; it was not tried against the emulator.

### Data retention

**The ledger and the transactions are never deleted** (they are the record). Two tables grow with traffic and are trimmed by the retention job (FR-103, FR-104): `inbox_messages` (one row per settled queue message) and `outbox_messages` (one row per event, published or not). The ledger and the transactions are the record and are kept by design.

- An inbox row is needed only while the same message can still arrive: the queue's retention (four days by default, fourteen at most) plus however long a message may sit in the DLQ before a replay. Deleting older rows is safe for that reason, and only for that reason.
- A published outbox row is needed by nobody once it is out, except as an audit of what was sent; the lag and backlog queries read only the unpublished rows, through a partial index, so the published ones cost storage and not speed.
- **The job** (`ApplyRetention`, in the publisher role) wakes every `RETENTION_INTERVAL_MS` (1 hour), deletes one batch of 1,000 of each table by age, and goes again at once while a batch was full. The deletes take `FOR UPDATE SKIP LOCKED`, so several processes running it take different rows instead of waiting on each other. `INBOX_RETENTION_DAYS` defaults to 21: the queue keeps a message at most 14 days, plus a week of allowance for a message sitting in the DLQ before a replay. **It must stay above both**: shortening it below the queue's retention lets a late redelivery reach settlement without its inbox row. Whether the idempotency key then catches it was not tested here. `OUTBOX_RETENTION_DAYS` defaults to 30 and applies to published rows only.
- **What it does not do.** It does not archive: what it deletes is gone (the published events are in the broker and with their consumers, and the ledger still explains every balance). It does not reclaim disk by itself: PostgreSQL reuses the space of deleted rows, and returning it to the system needs `VACUUM FULL` or `pg_repack`, which is an operator's decision. It deletes from the clock of the process running it, so clocks that disagree by days would disagree on what is old. The defaults are judgements, not measured on a real volume.

### Consuming the events

Events go to `wagering-events.fifo`, one message per event, with the wallet as `MessageGroupId` and the `eventId` as `MessageDeduplicationId`. The envelope and each event's `data` are specified in REQUIREMENTS section 3.12.1, and versioned by `version` (FR-94). **A consumer must deduplicate on `eventId` and order a wallet's balance changes by `walletVersion`** (IR-03): delivery is at least once, and a retry can send an earlier event after a later one.

## Decisions the challenge asks to justify

| Topic | Choice | Record |
| --- | --- | --- |
| ORM | MikroORM with separate persistence records | [ADR-0002](docs/adr/0002-persistence-records-are-separate-from-domain-classes.md) |
| `Money` mapping | `bigint` minor units, `numeric(20,2)` in the database | [ADR-0004](docs/adr/0004-money-is-bigint-minor-units.md) |
| Transaction and concurrency | Row lock per wallet, before any insert | [ADR-0003](docs/adr/0003-wallet-row-lock-is-taken-before-any-insert.md) |
| Idempotency | Two unique keys and a stored result | [ADR-0005](docs/adr/0005-idempotency-is-enforced-by-two-unique-keys.md) |
| Reversals | One processed reversal per reference | [ADR-0006](docs/adr/0006-one-processed-reversal-per-reference.md) |
| Outbox | Lease claim | [ADR-0007](docs/adr/0007-outbox-claims-with-a-lease.md) |
| HTTP settles synchronously | The response is the settlement | [ADR-0010](docs/adr/0010-http-settles-synchronously.md) |
| Inbox and outbox | Rows written by the use case, claimed by statements | [ADR-0013](docs/adr/0013-inbox-and-outbox-are-rows-not-domain-classes.md) |
| Errors | One envelope, one mapping | [ADR-0012](docs/adr/0012-errors-are-one-envelope-with-one-mapping.md) |
| Authentication | Not implemented, extension point documented | [ADR-0009](docs/adr/0009-authentication-is-a-documented-extension-point.md) |

## Known limitations

- **No authentication.** Anyone reaching the API can act as any provider (T-06). Do not expose it.
- **Throughput per wallet is serial** by design, and bounded by settlement time: about 145 bets per second on one wallet in the load test.
- **Late `BET` after an expired `ROLLBACK`** is applied, with no tombstone (REQUIREMENTS section 3.6).
- **One reversal per reference, of any kind.** This reads the challenge's rule 7.4 more strictly than its literal text on purpose, because mixing `REFUND` and `ROLLBACK` on one `BET` would credit it twice. The owner confirmed this decision. As a consequence, `REFUND`, `ROLLBACK` of it, then `ROLLBACK` of the `BET` is refused and needs an operator (ADR-0006).
- **Emulator, not AWS:** contract tests cover the SQS behaviour relied on, and do not prove parity with AWS (ADR-0008).
- **Defaults are judgements that a short load test did not contradict:** the lock, statement and acquire timeouts, the pool size, the backoffs, the leases and the batch sizes each have their reasoning above; none has been checked under sustained load.
- **Event publishing throughput is about 130 to 250 events per second** for three publishers on the reference machine, far below what settlement can produce.
- **A database outage spends at most one delivery of the batch in hand** (the consumer stops receiving while the probe fails, FR-101); a message that fails while the database answers still reaches the DLQ after five. Replaying the DLQ is safe, and manual: there is no tool for it.
- **A waiting reversal is settled at its next look,** up to the current backoff after its bet arrives.
- **Events are at least once and may reorder** within a wallet after a retry; consumers follow IR-03.
- **Reconciliation scans the whole ledger of the wallet** it is asked about, so its cost grows with the ledger. It is bounded in how many run at once, not in how long each takes: `RECONCILIATION_MAX_CONCURRENT` (2) per process, one over is a `503` at once (FR-102), so the rest of the pool stays for settlement. The bound is per process: N processes allow N times as many against the database. A checkpointed, incremental check, which would make the cost independent of the ledger, was not built: it would be a second source of truth for the balance to keep honest, and the endpoint is a diagnostic, not a hot path.
- **Retention deletes and does not archive or reclaim disk** (see Data retention); the ledger and the transactions grow without bound by design.
- **Replaying the DLQ is manual,** a few SQS calls, described in Operating it.
- **The failure suite's kill points are the ones it finds** (a held acknowledgement, a held publish, held locks), not an arbitrary instruction.

## Roadmap

Live status is on the [project board](https://github.com/users/JonasBorgesLM/projects/10) (private until delivery). Each issue states its done criterion, its known failure mode, and the documents it must update.

| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Base: tooling, CI, platform, runtime contracts, documents | Done |
| 1 | Domain: `Money`, `Wallet`, `WagerTransaction`, ledger, settlement policy, integration events, payload hash | Done |
| 2 | Schema: migrations, constraints, triggers, persistence records and mappers | Done |
| 3 | Settlement use case and HTTP API | Done |
| 4 | SQS consumer, inbox, DLQ, shutdown | Done (#15, #16, #17) |
| 5 | Outbox and publisher | Done (#18) |
| 6 | Out-of-order references worker | Done (#19) |
| 7 | Reconciliation and observability | Done (#20, #21) |
| 8 | Multi-process failure suite (challenge §13) | Done (#22) |
| 9 | Final documents, optional load test, release | Done (#23, #24, #25): v1.0.0 |
| 10 | Hardening after v1.0.0: batched publishing, security scan, stress run, consumer gate, reconciliation bound, retention, mutation and model-based tests | Done (#51 to #60): v1.1.0 |
