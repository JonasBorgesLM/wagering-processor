# wagering-processor — Threat Model

**Scope:** player balances and the audit trail behind them.
**Companion to:** [`REQUIREMENTS.md`](REQUIREMENTS.md). Every mitigation names the requirement that discharges it.

> Most threats here are not attackers. The realistic way this system loses money is a retry, a race, or a crash at the wrong moment. §7 lists what is not covered.

**Status:** no business code exists yet, so every mitigation below is designed, not verified. Each becomes verified when its test has been seen failing.

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
**Residual:** full. This is the largest open risk, and the system must not be exposed publicly as it stands.

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
**Residual:** a message that keeps failing transiently holds its wallet's later messages for its backoff (2 to 30 s), 5 times. And the other side of the same bound: with the defaults, a database outage longer than about 30 s dead-letters the messages that were in flight. Nothing is lost and replaying them from the DLQ is safe (idempotency), but it is an operator's job, and the defaults are judgements and not measured.

### T-11 — Resource exhaustion
**Actor:** any HTTP caller. **Impact:** connection pool or lock pile-up, huge payloads.
**Mitigation:** SR-04, FR-60, FR-64. Request bodies are capped at 16 KB, ledger pages at 200, path ids must be UUIDs, and every statement has a time limit (NFR-11).
**Residual:** no rate limit exists. A burst on one wallet can hold every pooled connection until the lock timeout; the wait for a connection is bounded (DATABASE_ACQUIRE_TIMEOUT_MS) and a burst test shows requests end as applied, rejected or 503, but the defaults are judgements and are not measured under sustained load. Authentication is absent (SR-03), so any caller can submit for any provider.

### T-12 — Idempotency key squatting
**Actor:** malicious caller. **Impact:** using a provider's future key or id makes its real operation fail as a conflict.
**Mitigation:** FR-53, FR-54 keep money correct.
**Residual:** the denial itself is not prevented, since keys are global and callers are unauthenticated (SR-03).

### T-13 — Compromised dependency
**Actor:** package or action maintainer. **Impact:** code execution in CI or production.
**Mitigation:** NFR-10.
**Residual:** a pinned version can already be malicious. The audit covers only known advisories.

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
| T-09 | FR-70, NFR-02, SR-06 |
| T-10 | FR-80, IR-02 |
| T-11 | FR-60, SR-04 |
| T-12 | FR-53, FR-54 |
| T-13 | NFR-10 |

SR-02 is hardening: it keeps T-05 true on the queue path.

## 6. Verification

Each threat maps to tests in the challenge's mandatory suite (§13). Each protection is removed once to watch its test go red, as noted in the test.

## 7. Explicitly not addressed

| What | Whose problem |
| --- | --- |
| Provider and player authentication and authorization | [ADR-0009](docs/adr/0009-authentication-is-a-documented-extension-point.md) design; not implemented |
| Rate limiting, DDoS | Edge infrastructure |
| Encryption at rest, in transit, secret management | Deployment. Compose credentials are local test values |
| Fraud, game fairness, responsible-gaming limits | Provider and platform |
| Consumers that do not deduplicate | The consumer (IR-03) |
| Backup and disaster recovery | Deployment |
