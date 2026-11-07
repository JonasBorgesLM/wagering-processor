# Load test

An experiment, not a benchmark and not a promise. It was run on one laptop, three times, and the numbers belong to that laptop. What it is worth is the shape of the results and what they say about the defaults, which until now were judgements.

## How to run it

```bash
docker compose up -d --wait postgres sqs
bun run provision && bun run test:load
```

Parameters (environment): `LOAD_DURATION_S` (20), `LOAD_WARMUP_S` (3), `LOAD_CONCURRENCY` (64), `LOAD_WALLETS` (200), `LOAD_PROCESSES` (3), `LOAD_ONLY` (`spread` or `hot-wallet`). Each run writes `load-results/<time>.json` (not committed) and prints it. It takes about four minutes, most of it waiting for the outbox to drain. It asserts one thing, that the books balance afterwards, and exits non-zero if they do not; everything else is a measurement.

## Environment

| | |
| --- | --- |
| Machine | Apple M1, 8 cores, 8 GB, macOS (Darwin 25.6) |
| Runtime | Bun 1.4.4; three application processes, each with every role (`api`, `consumer`, `publisher`, `reference-worker`) |
| Services | PostgreSQL 18 and the MiniStack SQS emulator in Docker on the same machine (Docker VM: 8 CPUs, 4 GB) |
| Load generator | The same machine, the same cores, a Bun script |
| Configuration | The shipped defaults: lock timeout 2 s, statement timeout 5 s, pool of 10 per process, 1 s to get a connection, outbox batch of 25 polled every 500 ms |

The generator, the three processes and the database share eight cores, so none of the numbers below is the capacity of the application alone, and **this run does not say which component was the limit** on the spread scenario: no CPU profile was taken.

## Method

Closed loop: 64 workers, each sends its next `POST /wagering/transactions` (a `BET` of 1.00, a fresh idempotency key) when the previous one has answered, rotating over the three processes. Three seconds of warm-up, then a 20-second window. No retries: a `503` is counted as a `503`. Wallets start with 1,000,000.00 so none runs out of funds.

- **Spread:** 200 wallets, requests rotate over them.
- **Hot wallet:** one wallet takes every request.

Throughput is bets answered `200` per second in the window. Latency is of answered `200` and `422`, measured at the client. Lock conflicts and database failures are read from `/metrics` of the three processes, as a change over the window. Outbox lag is sampled every second from `wagering_outbox_lag_seconds` (the age of the oldest event not yet published), and after the load the test waits for the outbox to empty and times it. Each scenario starts with an empty outbox. After each scenario the ledger of every wallet is rebuilt and compared with its balance.

**A closed loop understates latency under overload.** When an answer is slow the sender is slowed too, so the load it offers falls (coordinated omission). The numbers say how the system answers a fixed number of waiting callers, not what an open stream of arrivals would see.

## Results, three runs

| | Spread (200 wallets) | Hot wallet (1 wallet) |
| --- | --- | --- |
| Throughput, bets per second | 461, 497, 447 | 152, 144, 142 |
| Latency p50 (ms) | 127, 119, 125 | 77, 46, 50 |
| Latency p95 (ms) | 244, 211, 271 | 1318, 1389, 1309 |
| Latency p99 (ms) | 322, 298, 430 | 1476, 1624, 1404 |
| Latency max (ms) | 409, 590, 671 | 1626, 1830, 1479 |
| Answers `200` / `503` | 9342 / 0, 10103 / 0, 9027 / 0 | 3103 / 0, 2951 / 9, 2917 / 2 |
| Error rate | 0 | 0, 0.3 %, 0.07 % |
| Lock timeouts, deadlocks | 0, 0 | 0, 0 |
| Other transient database failures | 0 | 0, 10, 2 |
| Outbox lag at the end of the load (s) | 22.8, 22.5, 22.6 | 20.5, 21.8, 20.2 |
| Events unpublished at the end of the load | 21294, 21998, 20307 | 5689, 5220, 4985 |
| Time to publish that backlog (s) | 154, 177, 161 | 45, 40, 38 |
| Books balance afterwards | yes, yes, yes | yes, yes, yes |

One more run, hot wallet at 256 callers instead of 64: 207 bets per second, p50 1158 ms, p95 1376 ms, p99 1474 ms, **139 of 4486 answers `503` (3.1 %)**, no lock timeout, 147 transient database failures. The backlog was 10,467 events, published in 80 s.

## What it says

**Nothing was lost or wrong.** Every run ended with every ledger rebuilding its balance, and the money that moved equal to the bets answered `200`. Under 64 and 256 callers the errors were `503` (nothing changed, resend), never `500`, never a wrong answer.

**One wallet is serial, as designed.** About 145 bets per second on a hot wallet is about 7 ms per settlement, in a row. Callers queue on the lock: p50 is short and p95 is 1.3 s, because the wait is what is left after the others have gone first. The ADR's earlier figure of 4 ms was taken with 40 operations and no generator on the machine; this is a heavier setting and I did not isolate which part of the 7 ms grew.

**The lock timeout was close.** With 64 callers on one wallet the slowest answer was 1.8 s against a 2 s lock timeout. Nothing timed out here, but the margin is small, and a few more callers on one wallet would turn queueing into `503`.

**At 256 callers it is the pool, not the lock, that sheds.** The 3.1 % of `503` came with zero lock timeouts: 85 callers per process against a pool of 10 and a 1 s wait for a connection means some give up before reaching the lock. That is the behaviour ADR-0003 and T-11 describe, observed.

**Publishing is the bottleneck, by a wide margin, and this is the finding that matters.** The publishers emptied the backlog at 125 to 138 events per second in total (about 40 per publisher), while settlement produced about 2 events per bet, or roughly 900 per second at the spread rate. During the load almost nothing was published: the lag at the end is about the length of the run, and 97 % of the events of the spread scenario were still waiting (72 to 75 % on the hot wallet, where fewer were produced). That is roughly 25 events per second published while settling, a fifth of the drain rate, so the publishers also compete for the same cores and connections while the load runs; that is read from the numbers, not profiled. The outbox is correct (it never lost or duplicated an event) and it is **behind by design of its batch**: each publisher sends one message at a time, which at the observed rate is roughly 23 ms each against the emulator, so three of them top out near 130 per second. **A sustained rate above about 65 bets per second on this machine makes the lag grow without bound** until the load stops. The cause is read from the rate and not profiled. The obvious levers are `SendMessageBatch` (ten per call) and sending different wallets' events in parallel, both of which keep a wallet's order; neither is done.

## What this does not show

- **Sustained load.** The window is 20 seconds. Nothing here says what happens after an hour: vacuum, a ledger of millions of rows, a growing outbox table.
- **A real network, real AWS, or a real database host.** Everything is on one machine, and the broker is an emulator whose send latency is not SQS's.
- **Which component limits the spread scenario.** It might be the database, the processes or the generator.
- **Variance beyond three runs.** They agree within about 10 %, which is encouraging and not a confidence interval.
- **Mixed traffic.** Reversals, queue messages, duplicates and the reference worker were not part of the load.
- **A target.** The challenge gives no requests-per-second goal, so there is no pass or fail here, only the figures.
