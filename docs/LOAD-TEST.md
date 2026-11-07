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
| Configuration | The shipped defaults at the time of each run: lock timeout 2 s, statement timeout 5 s, pool of 10 per process, 1 s to get a connection, outbox batch of 25 (100 after #51) polled every 500 ms |

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

**Publishing is the bottleneck, by a wide margin, and this is the finding that matters. (Measured before issue #51; see "After batching" below for what changed.)** The publishers emptied the backlog at 125 to 138 events per second in total (about 40 per publisher), while settlement produced about 2 events per bet, or roughly 900 per second at the spread rate. During the load almost nothing was published: the lag at the end is about the length of the run, and 97 % of the events of the spread scenario were still waiting (72 to 75 % on the hot wallet, where fewer were produced). That is roughly 25 events per second published while settling, a fifth of the drain rate, so the publishers also compete for the same cores and connections while the load runs; that is read from the numbers, not profiled. The outbox is correct (it never lost or duplicated an event) and it is **behind by design of its batch**: each publisher sends one message at a time, which at the observed rate is roughly 23 ms each against the emulator, so three of them top out near 130 per second. **A sustained rate above about 65 bets per second on this machine makes the lag grow without bound** until the load stops. The cause is read from the rate and not profiled. The obvious levers are `SendMessageBatch` (ten per call) and sending different wallets' events in parallel, both of which keep a wallet's order; neither is done.

## After batching the sends (issue #51)

The publishers were changed to claim 100 rows a round (it was 25) and send them ten to a call with `SendMessageBatch`, over a configurable number of lanes (`OUTBOX_PUBLISH_CONCURRENCY`), keeping each wallet's events in one lane and in order. The same test, the same machine, three runs each:

| | Before (25 rows, one message a call) | 100 rows, ten to a call, **1 lane** (the default) | 100 rows, ten to a call, 4 lanes |
| --- | --- | --- | --- |
| Spread, bets per second | 461, 497, 447 | 465, 398, 454 | 393, 418, 413 |
| Spread, p50 / p99 (ms) | 119-127 / 298-430 | 124-130 / 280-646 | 139-142 / 339-453 |
| Hot wallet, bets per second | 152, 144, 142 | 120, 132, 130 | 115, 117, 121 |
| Hot wallet, p50 (ms) | 77, 46, 50 | 57, 42, 68 | **604, 115, 600** |
| Events unpublished when the load stopped (spread) | 21294, 21998, 20307 | 19604, 18314, 20600 | 13156, 18232, 18496 |
| Seconds to publish that backlog (spread) | 154, 177, 161 | 78, 136, 145 | 30, 112, 134 |
| Hot wallet at 256 callers: `503` | 139 of 4486 | not run | 1185 of 3762 |
| Books balance afterwards | yes | yes | yes |

**It did not make the publishers keep up.** Settlement still produces about 900 events per second at the spread rate and the publishers still empty the backlog at about 130 to 250 per second, so the lag still grows through a sustained load, and a backlog of about 20,000 events still takes one to three minutes to clear. The drain rate varies a good deal between runs, more than the figures of settlement do.

**Why, measured on its own** (a throwaway probe, not committed: the publisher over a backlog of 6,000 events with nothing else running, and the broker alone):

| | |
| --- | --- |
| One `SendMessage` to the emulator | 14.4 ms |
| One call with ten messages | 62.5 ms, so 6.3 ms a message |
| Four lanes of ten-message calls at once | 168 messages per second in all, and each call took about four times as long as when alone |
| Publisher, 25 rows, one at a time (before) | 137 events per second |
| Publisher, 100 rows, ten a call, 1 lane | 185 per second |
| Publisher, 100 rows, ten a call, 4 lanes | 230 per second |
| Publisher, 250 rows, ten a call, 8 lanes | 300 per second |
| Share of the time spent claiming and marking | under 5 % in every configuration |

So batching and lanes did what they were meant to: from 137 to as much as 300 events per second for a publisher alone. But **the emulator serializes requests**: calls made at the same time take proportionally longer, so more lanes buy little and the broker, not the database or the code, is the ceiling here. Claiming and marking cost almost nothing.

**More lanes hurt settlement on this machine.** The publishers are faster with more lanes and spend the cores that settlement needs: the hot wallet's p50 went from about 50 ms to about 600 ms in two of three runs, and the `503` of the 256-caller run went from 139 to 1185. With one lane the settlement figures are back to near where they were. That is why the default is one lane, and why the lanes stay as a setting: where the broker is real and the publishers run on their own hosts the trade is different, and this experiment cannot show it.

**What is therefore still true:** a sustained rate above roughly 65 to 125 bets per second makes the outbox lag grow until the load stops, on this machine and this emulator. Whether real SQS lifts that was not measured.

## What this does not show

- **Sustained load.** The window is 20 seconds. Nothing here says what happens after an hour: vacuum, a ledger of millions of rows, a growing outbox table.
- **A real network, real AWS, or a real database host.** Everything is on one machine, and the broker is an emulator whose send latency is not SQS's.
- **Which component limits the spread scenario.** It might be the database, the processes or the generator.
- **Variance beyond three runs.** They agree within about 10 %, which is encouraging and not a confidence interval.
- **Mixed traffic.** Reversals, queue messages, duplicates and the reference worker were not part of the load.
- **A target.** The challenge gives no requests-per-second goal, so there is no pass or fail here, only the figures.
