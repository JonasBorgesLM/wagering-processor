# wagering-processor — Threat Model

**Scope:** player balances and the audit trail behind them.
**Companion to:** [`REQUIREMENTS.md`](REQUIREMENTS.md). Every mitigation names the requirement that discharges it.

> Most threats here are not attackers. The realistic way this system loses money is a retry, a race, or a crash at the wrong moment. §7 lists what is not covered.

**Status:** every mitigation below is implemented and has a test; section 6 names them and says which protections were also removed to watch the test fail. Threats with no mitigation in code (T-06, T-07) are said to be open, in the same place. A mitigation is verified when its test has been seen failing, and where that was not done it says so.

---

## 1. What is being protected

| Asset | Why it matters | Exposure |
| --- | --- | --- |
| Wallet balance | It is money. A wrong value is a direct loss or a player dispute | HTTP, queue, workers |
| Ledger | The only evidence of why a balance is what it is | Written by settlement; read over HTTP |
| Idempotency records | Losing one turns a retry into a duplicate movement | Database |
| Confirmed events | Downstream systems act on them; a lost one is a silent divergence | Outbox, broker |
| Player and wallet ids, balances | Personal financial data | HTTP responses, logs |

**The asymmetry:** a refused operation can be retried, and a provider can recover from it. A wrong movement that has been committed cannot be silently undone, because the ledger is immutable. So every doubtful case refuses, and the design prefers a false rejection to a false credit (`INT-06`).

## 2. Actors and capabilities

| Actor | Assumed capability | Assumed *not* to have |
| --- | --- | --- |
| Honest provider | Duplicates, reorders, and retries for any reason | Knowledge of our internal ids |
| Buggy or malicious caller | Any HTTP payload, since no authentication exists (SR-03) | Direct database or queue access |
| Internal queue producer | Can publish any message; trusted channel by §2 of the challenge | Bypass of domain validation |
| Crashing process | Dies at any instruction, including between commit and ack | Partial SQL transactions: PostgreSQL makes them atomic |
| Database administrator | Superuser, can disable triggers | Out of scope to stop; detection is partial |

## 3. Trust boundaries

```text
provider ──HTTP──▶ [ API ]──┐
                            ├──▶ [ settlement ] ──▶ PostgreSQL (source of truth)
queue ───SQS────▶ [ consumer ]┘                          │
                                                  [ outbox worker ] ──▶ event queue
```

- **HTTP and queue to settlement:** nothing is trusted. Both pass the same validation, and the queue being internal does not exempt identity fields.
- **Settlement to PostgreSQL:** the schema is the last line. It assumes the application can be wrong.
- **Outbox to consumers:** delivery is at-least-once, and consumers are responsible for deduplicating.

## 4. Threats

### T-01 — Duplicate delivery moves money twice
**Actor:** honest provider, queue. **Impact:** double debit or credit, an elimination criterion.
**Mitigation:** FR-50, FR-52, NFR-02, NFR-04.
**Residual:** none known, conditional on every entry path using the shared settlement use case.

### T-02 — Concurrent operations corrupt a balance
**Actor:** several instances. **Impact:** lost update, negative balance.
**Mitigation:** NFR-02, NFR-03, FR-14.
**Residual:** a hot wallet queues on its lock, so a sustained burst shows up as latency and `503`, not as wrong money.

### T-03 — Crash between commit and acknowledgement
**Actor:** crashing process. **Impact:** redelivery of committed work, or an unpublished event.
**Mitigation:** NFR-04, FR-90, FR-91, IR-01.
**Residual:** an event can be published more than once, so consumers must follow IR-03.

### T-04 — One reference reversed twice
**Actor:** honest provider, malicious caller. **Impact:** a stake credited twice.
**Mitigation:** FR-22, FR-27, FR-29, NFR-02.
**Residual:** a legitimate refund, rollback of it, then rollback of the bet is refused and needs an operator (`INT-06`).

### T-05 — Operating on another player's wallet
**Actor:** buggy or malicious caller. **Impact:** money moved on the wrong wallet.
**Mitigation:** FR-21, SR-05.
**Residual:** partial. Without authentication, a caller who knows the matching `playerId` and `walletId` passes this check (SR-03).

### T-06 — Impersonating a provider
**Actor:** any HTTP caller. **Impact:** forged bets, wins and reversals.
**Mitigation:** SR-03 records this as accepted; none in code.
**Residual:** full. This is the largest open risk, and the system must not be exposed publicly as it stands. It includes `POST /wallets`, which opens a wallet with any initial balance up to the column's limit: without authentication, anyone who reaches the API can create money in the books.

### T-07 — Reading another player's data
**Actor:** any HTTP caller. **Impact:** disclosure of balances and history.
**Mitigation:** FR-58 closes only the rejection-response path.
**Residual:** the `GET` endpoints are open to anyone with an id. UUIDs make guessing hard but are not access control. The ledger endpoint returns a wallet's whole history, paged, to anyone who holds its id.

### T-08 — Sensitive values reach logs
**Actor:** log readers. **Impact:** financial data exposure.
**Mitigation:** SR-01, through an allowlist of logged fields.
**Residual:** a sensitive value placed inside an allowed field, such as an error message containing a payload, is still written.

### T-09 — Ledger tampering
**Actor:** database administrator, application bug. **Impact:** a false audit trail.
**Mitigation:** SR-06, NFR-02, FR-70, FR-97 to FR-99. Reconciliation reports a balance that the ledger does not explain, or an entry that does not add up or chain, as a divergence in the response, the log and a metric.
**Residual:** a superuser can disable the trigger and alter both balance and ledger consistently. That is undetectable here; a hash chain would be needed. In Compose the application itself connects as a superuser, so the triggers stop application bugs there, not a hostile operator. A deployment needs an application role that does not own the tables, which this project does not provide.

### T-10 — Poison message blocks a wallet
**Actor:** queue producer. **Impact:** a FIFO group stalls, delaying that wallet.
**Mitigation:** FR-83, FR-80, IR-02 and the DLQ outcomes in §3.11 of the requirements. A permanent failure is dead-lettered at its first delivery and does not hold its wallet; a transient one is retried with a growing backoff and dead-lettered after 5 deliveries.
**Residual:** a message that keeps failing transiently holds its wallet's later messages for its backoff (2 to 30 s), 5 times. And the other side of the same bound: the consumer stops receiving while the database does not answer (FR-101), so an outage no longer spends the deliveries of what is waiting; the batch in hand when it begins spends one, and a message that fails while the database answers still reaches the DLQ after five. Replaying from the DLQ is safe (idempotency) but an operator's job, and the defaults are judgements and not measured.

### T-11 — Resource exhaustion
**Actor:** any HTTP caller. **Impact:** connection pool or lock pile-up, huge payloads.
**Mitigation:** SR-04, FR-60, FR-64. Request bodies are capped at 16 KB, ledger pages at 200, path ids must be UUIDs, and every statement has a time limit (NFR-11).
**Residual:** no rate limit exists. A burst on one wallet can hold every pooled connection until the lock timeout; the wait for a connection is bounded (DATABASE_ACQUIRE_TIMEOUT_MS) and a burst test shows requests end as applied, rejected or 503, but the load test (20-second runs, one machine) saw 64 callers on one wallet answered within 1.8 s and 256 callers shed 3.1 % as `503` with no lock timeout, but sustained load was not tried and the defaults remain judgements. Authentication is absent (SR-03), so any caller can submit for any provider.

### T-12 — Idempotency key squatting
**Actor:** malicious caller. **Impact:** using a provider's future key or id makes its real operation fail as a conflict.
**Mitigation:** FR-53, FR-54 keep money correct.
**Residual:** the denial itself is not prevented, since keys are global and callers are unauthenticated (SR-03).

### T-13 — Compromised dependency
**Actor:** package or action maintainer. **Impact:** code execution in CI or production.
**Mitigation:** NFR-10.
**Residual:** a pinned version can already be malicious. The audit covers only known advisories.

### T-14 — Event delivery falls behind
**Actor:** sustained traffic. **Impact:** downstream systems see settled operations late, for as long as the load lasts.
**Mitigation:** none of capacity; FR-91 keeps every event and `wagering_outbox_lag_seconds` makes the delay visible.
**Residual:** measured in the load test: three publishers send about 130 to 250 events per second while settlement can produce about 900, so above roughly 65 to 125 bets per second sustained the lag grows without bound. Nothing is lost or duplicated. The sends are batched (ten to a call), and the local emulator, which handles requests one after another, is the ceiling; real SQS was not measured.

### T-15 — Unbounded storage growth
**Actor:** time. **Impact:** `inbox_messages` and `outbox_messages` grow with every message and event, and nothing deletes them; on a long-running system the disk fills.
**Mitigation:** a retention job in the publisher role deletes inbox rows older than `INBOX_RETENTION_DAYS` (21, above the queue's 14-day maximum plus a DLQ allowance) and published outbox rows older than `OUTBOX_RETENTION_DAYS` (30), in batches, and never an unpublished one (FR-103, FR-104).
**Residual:** the ledger and the transactions are kept forever by design, so storage still grows with the number of transactions, only slower. Deleted space is reused but not returned to the system without `VACUUM FULL`. The defaults are judgements and were not measured on a real volume. An inbox retention set below the queue's would let a late redelivery reach settlement without its inbox row (not tested what the idempotency key then does).

### T-16 — An expensive read used as a lever
**Actor:** any HTTP caller. **Impact:** `POST /wallets/:walletId/reconciliation` reads a wallet's whole ledger in one statement; a few concurrent calls on a large wallet hold pooled connections for up to the statement timeout (5 s) and delay settlement on the same process.
**Mitigation:** the statement timeout bounds each call, the read takes no lock, so it cannot block a wallet directly, and at most `RECONCILIATION_MAX_CONCURRENT` (2) run at once per process; one over is a `503` at once (FR-102), so the pool keeps its other connections for settlement.
**Residual:** no rate limit and no authentication (SR-03). Two reconciliations per process can still be held busy for the statement timeout each, and the bound is per process, so N processes allow N times as many. The cost of each call still grows with the ledger. The ledger page is bounded (200 entries) and is not a lever; the reconciliation is.

### T-17 — A JSON response used as something else
**Actor:** a browser, a shared cache. **Impact:** a body sniffed as a script or markup, a page framed, an id leaked in a `Referer`, a balance kept by a cache.
**Mitigation:** FR-100. Found by the security scan ([`docs/SECURITY-SCAN.md`](docs/SECURITY-SCAN.md)), which saw none of these headers; they are now on every response, tested on each kind of answer.
**Residual:** `Strict-Transport-Security` goes only on a request that arrived over TLS, so over plain HTTP the scanner still reports it; TLS is the deployment's (section 7). There is still no CORS configuration, which is the secure default for an API no browser is meant to call.

## 5. Coverage matrix

| Threat | Requirements |
| --- | --- |
| T-01 | FR-50, FR-52, NFR-02, NFR-04 |
| T-02 | FR-14, NFR-02, NFR-03 |
| T-03 | FR-90, FR-91, IR-01, IR-03, NFR-04 |
| T-04 | FR-22, FR-27, FR-29, NFR-02 |
| T-05 | FR-21, SR-05 |
| T-06 | SR-03 |
| T-07 | FR-58, SR-03 |
| T-08 | SR-01 |
| T-09 | FR-70, FR-97 to FR-99, NFR-02, SR-06 |
| T-10 | FR-80, FR-82, FR-83, IR-02 |
| T-11 | FR-60, FR-64, FR-74, SR-04 |
| T-12 | FR-53, FR-54 |
| T-13 | NFR-10 |
| T-14 | FR-91, NFR-06 |
| T-15 | FR-103, FR-104 |
| T-16 | FR-71, FR-102, NFR-11 |
| T-17 | FR-100, FR-65 |

SR-02 is hardening: it keeps T-05 true on the queue path.

## 6. Verification

What each mitigation is tested by, and whether the protection was removed to see the test go red. "Removed" means a mutation was run and the named test failed. Since issue #55 the main ones are repeatable: `bun run test:mutation` applies the 22 mutants of `test/mutation/mutants.ts` (each a protection named in the table below, with the tests that must go red) and fails if any survives or no longer applies; `--list` shows them. The rest of this column was done by hand, PR by PR, and is not repeatable.

| Threat | Tests | Protection removed and seen red |
| --- | --- | --- |
| T-01 duplicate delivery | `test/concurrency/settlement.test.ts` (50 at once), `multiprocess.test.ts` scenarios 1, 2 and 8, `integration/inbox.test.ts`, `settlement.test.ts` | the idempotency lookup, the inbox record, the hash comparison (all three: `test:mutation`) |
| T-02 concurrent corruption | `multiprocess.test.ts` scenarios 2 and 3, `concurrency/settlement.test.ts`, the schema tests for non-negative balances | the wallet lock (`test:mutation`); `check-instances.sh` with the lock removed (the database constraints still refused the overdraw) |
| T-03 crash after commit | `multiprocess.test.ts` scenarios 5 and 6, `consumer.test.ts`, `outbox-publisher.test.ts`, `inbox.test.ts` (a crash after each write) | acknowledging before the use case, marking an outbox row before publishing, and the outbox lease (all three: `test:mutation`). **`SKIP LOCKED` (the outbox and the pending-reference claim) was listed here as removed and seen red; the first repeatable run showed it was not:** no test noticed, the multi-process suite included. It is not what keeps two publishers off one row (the lease does that: a publisher that waited on the lock re-reads the row and finds it leased), it keeps them from waiting on each other, and a test for that was added then |
| T-04 double reversal | `schema.test.ts` (names the constraint that refused the row), `domain/settlement-policy.test.ts`, `reference-worker.test.ts`, `integration/settlement-model.test.ts` (random sequences against a reference model) | the one-reversal rule removed (`test:mutation`); the schema test asserts which constraint refuses |
| T-05 another player's wallet | `domain/settlement-policy.test.ts`, `http-transactions.test.ts` (`PLAYER_WALLET_MISMATCH`, no balance in the answer) | each pair of adjacent checks swapped (by hand); the player check removed (`test:mutation`) |
| T-06, T-07 | none: not mitigated | not applicable |
| T-08 sensitive values in logs | `integration/logging.test.ts` (HTTP, queue success and queue failure, reference worker), `unit/json-logger.test.ts`, `unit/messaging/describe-for-log.test.ts` | a payload value put in the log message text (the allowlist cannot see it, so only the test catches it); the consumer logging an error's message instead of its code |
| T-09 ledger tampering | `schema.test.ts` (append-only triggers), `reconciliation.test.ts` (with the trigger and the arithmetic constraint removed on purpose) | the chain check, the arithmetic check, the lock (by hand); the sign of the difference and the append-only trigger (`test:mutation`) |
| T-10 poison message | `consumer-failures.test.ts` (each permanent failure, attempts exhausted, PostgreSQL really stopped) | permanent retried instead of dead-lettered, attempts never exhausted (`test:mutation`); DLQ failure ignored (by hand) |
| T-11 exhaustion | `http-transactions.test.ts` (a burst larger than the pool), `settlement.test.ts` (the pool and the terminated connection), body-limit tests | the connection errors were found by the failure suite on a slow runner and fixed |
| T-12 key squatting | `settlement.test.ts`, `http-transactions.test.ts` (the conflicts) | the idempotency lookup |
| T-13 dependency | `bun audit` and the frozen lockfile in CI; images pinned by digest | not applicable |
| T-17 response hardening | `unit/http/security-headers.test.ts`, `integration/openapi.test.ts` (every kind of answer), the warden scan (28 findings before, 7 after, all HSTS over HTTP) | the middleware removed (`test:mutation`), and its old position after the body parser (by hand) |
| T-11 exhaustion, under stress | `./scripts/stress.sh` ([`docs/STRESS-TEST.md`](docs/STRESS-TEST.md)): spike, ramp-up, soak and a database outage, no `500`, books reconciled (measured, not a CI gate) | not applicable: a measurement |
| T-14 delivery behind | `bun run test:load` (measured, not asserted) | not applicable: a measurement |
| T-16 expensive read | `unit/application/reconcile-wallet.test.ts` (the bound, the release on success and on failure), `integration/reconciliation.test.ts` (a held pool: settlement is not starved) | the bound removed (settlement could not get a connection; `test:mutation`); the release removed (by hand) |
| T-15 storage growth | `integration/retention.test.ts` (real PostgreSQL: the cutoff, an unpublished row kept, batches), `unit/application/apply-retention.test.ts` | the unpublished guard removed (`test:mutation`); the inbox cutoff moved 30 days later (by hand) |

## 7. Explicitly not addressed

| What | Whose problem |
| --- | --- |
| Provider and player authentication and authorization | [ADR-0009](docs/adr/0009-authentication-is-a-documented-extension-point.md) design; not implemented |
| Rate limiting, DDoS | Edge infrastructure |
| Encryption at rest, in transit, secret management | Deployment. Compose credentials are local test values |
| Fraud, game fairness, responsible-gaming limits | Provider and platform |
| Consumers that do not deduplicate | The consumer (IR-03) |
| Backup and disaster recovery | Deployment |
