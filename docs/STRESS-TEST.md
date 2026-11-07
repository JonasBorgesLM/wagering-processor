# Stress test

Four scenarios driven by the owner's load tool, [sapper](https://github.com/JonasBorgesLM/sapper), against this service's own stack: a spike, a ramp-up, a ten-minute soak, and a dependency outage. They answer a different question from [`LOAD-TEST.md`](LOAD-TEST.md). That one measures how fast the system is; this one states, **before running**, what the service must never do under abuse, and checks it. Like the load test, the figures belong to one laptop and are a shape, not a promise.

## How to run it

```bash
docker compose up -d --wait postgres sqs && bun run provision
SAPPER_SRC=/path/to/sapper ./scripts/stress.sh                 # spike, ramp-up, outage (about 4 minutes)
SAPPER_SRC=/path/to/sapper ./scripts/stress.sh soak            # ten minutes
```

Needs a sapper with request bodies and `{{uuid}}`: [sapper PR #61](https://github.com/JonasBorgesLM/sapper/pull/61), ADR-0010 there. An older sapper refuses the scenarios at load. For each scenario `scripts/stress.sh` creates a throwaway database, seeds one wallet through the real use case (`scripts/seed-stress.ts`), starts one instance with every role on `127.0.0.1:3098`, runs sapper under `stress/sapper.yaml` (tier `lab`, concurrency capped at 128, auto-abort on a broken instance), asserts the SLOs, **then reconciles the wallet** (balance equals ledger) and counts transactions by status. Results go to `stress-results/` (not committed). The exit status is non-zero if any SLO or any reconciliation fails.

## What was asserted, written before the first run

For every scenario: **no `500`** (a bug or a terminal failure, never acceptable), **`503` below a stated share** (shedding load is allowed, shedding most of it is not), **transport errors under 1 %** (the instance keeps answering), and then the one assertion sapper cannot make, **the books balance**.

| Scenario | Load | Specific SLOs |
| --- | --- | --- |
| `spike` | 4 concurrent for 15 s, 96 for 10 s, 4 again | `503` < 5 %; p99 after the spike within 3× the baseline |
| `ramp-up` | 0 to 96 concurrent over 60 s | `503` < 5 %; p99 < 1.5 s (under the 2 s lock timeout, past which requests are being refused instead of queued) |
| `soak` | 16 concurrent for 10 minutes, in 10 windows | `503` < 1 %; last window's p99 within 2× the first's |
| `outage` | 16 concurrent for 60 s; PostgreSQL paused for 10 s from the 20th second | `503` < 40 %; p99 < 8 s |

## Results

One run each, on the machine of [`LOAD-TEST.md`](LOAD-TEST.md) (generator, instance and database on the same cores).

| Scenario | Responses | `500` | `503` | p99 | Other SLO | Wallet reconciled |
| --- | --- | --- | --- | --- | --- | --- |
| `spike` | 5,809 | 0 | 17 (0.29 %) | 515 ms mean over phases | recovery p99 80 ms vs baseline 79 ms | yes, 5,897 entries |
| `ramp-up` | 10,275 | 0 | 0 | 594 ms | | yes, 10,372 entries |
| `outage` | 8,097 | 0 | 68 (0.84 %) | 1.0 s | | yes, 8,767 entries |
| `soak` | 94,332 | 0 | 0 | 946 ms | last window 923 ms vs first 903 ms | yes, 94,491 entries |

All SLOs passed and every wallet reconciled. In each run the transactions counted `PROCESSED` equal the ledger entries minus the opening one; none was left in another state.

## What it says

- **No `500` in about 120,000 responses**, including the ten seconds without a database. The outage became `503` (`TRANSIENT`), which is the behaviour the failure suite asserts at small scale and this shows at a sustained rate.
- **One wallet is the worst case and it held at about 160 bets per second**, steadily: the soak's last window was within 2.2 % of its first, so nothing visible leaked or degraded over ten minutes. Requests queue on the row lock (ADR-0003) instead of being refused: the ramp-up saw no `503` at all.
- **The latency is the queue.** With 16 to 96 callers on one wallet, p99 is hundreds of milliseconds to a second. That is the serialization the design chose, not a defect found.
- **Recovery after a spike was complete** by the measure used: the post-spike p99 matched the baseline.

## What it does not show

- **One wallet only.** sapper cannot pick a wallet per request (ADR-0010 there names the reopening criterion), so these runs are the contention worst case. Spreading over many wallets is `test:load`'s job.
- **The outage is gentle and the closed loop hides its size.** Sixteen callers each wait on a hung query, so during the pause very few requests are even sent (only 68 `503`); a real client population would keep sending. The instance was not killed, only its database stopped answering, and PostgreSQL was the only dependency faulted. **sapper's fault-injection profile was not used**: it is an HTTP reverse proxy, and the broker's `QueueUrl`s name its own address, so the proxy is bypassed; faulting the broker is what `test/support/broker-proxy.ts` does in the failure suite, and PostgreSQL speaks no HTTP.
- **The outbox was not observed.** Sustained 160 bets per second is above the roughly 65 to 125 per second the publishers can keep up with (T-14), so the lag grew during these runs. The scenarios assert the HTTP side and the books, not the delivery.
- **One instance, with every role, loopback, a laptop.** Nothing about network latency, several instances behind a balancer, or a real SQS.
- **Single runs.** sapper aggregates repetitions to show spread (its ADR-0003); these were run once each, so the p99s carry no stated variance.

## Findings

Two defects, both in the tooling around the test, not in the service: the script's first version hung because `wait` also waited on the instance it had started, and the second scenario could not start because the previous instance had not released the port yet (the script now waits for it to exit). No finding against the service itself, and no code change to it.
