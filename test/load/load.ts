// A load test of the real application: three processes, one PostgreSQL, one broker, HTTP traffic from this script.
//
//   bun run test:load                       # defaults below
//   LOAD_DURATION_S=60 LOAD_CONCURRENCY=128 bun run test:load
//
// It is not part of any other suite: it takes minutes, its numbers belong to the machine it ran on, and it asserts one
// thing only, that the books balance afterwards. Everything else it prints is a measurement to be read with docs/LOAD-TEST.md.
//
// The loop is closed: each of `concurrency` workers sends the next request when the last has answered. That measures
// how fast the system answers under a fixed load, and it understates latency under overload (coordinated omission),
// because a slow answer also slows the sending. It says so in the output.

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { Cluster, type ClusterProcess } from "../support/cluster";
import { setUpEventsQueue, setUpQueues } from "../support/consumer-harness";
import { brl, command, SettlementWorld } from "../support/settlement";

const number = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
const DURATION_S = number("LOAD_DURATION_S", 20);
const WARMUP_S = number("LOAD_WARMUP_S", 3);
const CONCURRENCY = number("LOAD_CONCURRENCY", 64);
const WALLETS = number("LOAD_WALLETS", 200);
const PROCESSES = number("LOAD_PROCESSES", 3);
// A scenario name, to run only that one.
const ONLY = process.env.LOAD_ONLY;
const REQUEST_TIMEOUT_MS = 10_000;
// Past this the backlog is reported as not drained, and the next scenario starts with it still there.
const DRAIN_LIMIT_MS = 300_000;

// The defaults of the application, so what is measured is what ships. The cluster helper widens them for the
// failure suite and these put them back.
const DEFAULTS = {
  LOCK_TIMEOUT_MS: "2000",
  STATEMENT_TIMEOUT_MS: "5000",
  DATABASE_POOL_MAX: "10",
  QUEUE_WAIT_SECONDS: "5",
  OUTBOX_POLL_INTERVAL_MS: "500",
  OUTBOX_LEASE_MS: "30000",
  REFERENCE_POLL_INTERVAL_MS: "1000",
  REFERENCE_RETRY_BASE_SECONDS: "5",
  REFERENCE_RETRY_CAP_SECONDS: "300",
};

interface Sample {
  status: number | "error";
  ms: number;
}

interface Scenario {
  name: string;
  description: string;
  wallets: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

async function scrape(processes: ClusterProcess[]) {
  const totals = {
    lockTimeouts: 0,
    deadlocks: 0,
    transient: 0,
    retries: 0,
    duplicates: 0,
    lagSeconds: 0,
    unpublished: 0,
  };
  for (const proc of processes) {
    const text = await (await fetch(`${proc.url}/metrics`)).text();
    const sum = (re: RegExp) => [...text.matchAll(re)].reduce((n, m) => n + Number(m[1]), 0);
    totals.lockTimeouts += sum(/^wagering_lock_conflicts_total\{kind="lock_timeout"\} (\S+)/gm);
    totals.deadlocks += sum(/^wagering_lock_conflicts_total\{kind="deadlock"\} (\S+)/gm);
    totals.transient += sum(/^wagering_database_transient_failures_total\{[^}]*\} (\S+)/gm);
    totals.retries += sum(/^wagering_retries_total\{[^}]*\} (\S+)/gm);
    totals.duplicates += sum(/^wagering_duplicates_total\{[^}]*\} (\S+)/gm);
    // The same table is read by every process, so the largest is the truth and a sum would count it three times.
    totals.lagSeconds = Math.max(totals.lagSeconds, sum(/^wagering_outbox_lag_seconds (\S+)/gm));
    totals.unpublished = Math.max(totals.unpublished, sum(/^wagering_outbox_unpublished (\S+)/gm));
  }
  return totals;
}

async function runScenario(world: SettlementWorld, cluster: Cluster, scenario: Scenario) {
  const processes = await Promise.all(
    Array.from({ length: PROCESSES }, () =>
      cluster.start("api,consumer,publisher,reference-worker", DEFAULTS),
    ),
  );
  // Each scenario starts with an empty outbox, or the lag it reports would be the previous scenario's.
  const idle = performance.now();
  while (performance.now() - idle < DRAIN_LIMIT_MS) {
    const rows = (await world.sql(
      "select count(*)::int as n from outbox_messages where published_at is null",
    )) as Array<{
      n: number;
    }>;
    const n = rows[0]?.n ?? 0;
    if (n === 0) break;
    await Bun.sleep(1_000);
  }
  // Enough that no wallet runs out: a rejection for funds would measure something else.
  const wallets = await Promise.all(
    Array.from({ length: scenario.wallets }, () => world.openWallet("1000000.00")),
  );

  const samples: Sample[] = [];
  const lag: number[] = [];
  let measuring = false;
  let stop = false;
  let applied = 0;
  let unanswered = 0;

  const worker = async (index: number) => {
    let n = index;
    while (!stop) {
      const wallet = wallets[n++ % wallets.length] as (typeof wallets)[number];
      const op = command(wallet, { money: brl("1.00"), idempotencyKey: randomUUID() });
      const proc = processes[(index + n) % processes.length] as ClusterProcess;
      const started = performance.now();
      let status: Sample["status"] = "error";
      try {
        const response = await fetch(`${proc.url}/wagering/transactions`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": op.idempotencyKey },
          body: JSON.stringify({
            providerId: op.providerId,
            externalTransactionId: op.externalTransactionId,
            playerId: op.playerId,
            walletId: op.walletId,
            roundId: op.roundId,
            gameId: op.gameId,
            kind: "BET",
            money: op.money.toJSON(),
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        status = response.status;
        await response.arrayBuffer();
        if (response.status === 200) applied++;
      } catch {
        status = "error";
        unanswered++;
      }
      if (measuring) samples.push({ status, ms: performance.now() - started });
    }
  };

  const sampler = (async () => {
    while (!stop) {
      await Bun.sleep(1_000);
      if (measuring) lag.push((await scrape(processes)).lagSeconds);
    }
  })();

  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i));
  await Bun.sleep(WARMUP_S * 1_000);
  const startedAt = performance.now();
  const afterWarmup = await scrape(processes);
  measuring = true;
  await Bun.sleep(DURATION_S * 1_000);
  measuring = false;
  const seconds = (performance.now() - startedAt) / 1_000;
  const afterLoad = await scrape(processes);
  stop = true;
  await Promise.all([...workers, sampler]);

  // How long until every event is published: the backlog the publishers built up under load.
  const drainStarted = performance.now();
  let drained = await scrape(processes);
  while (drained.unpublished > 0 && performance.now() - drainStarted < DRAIN_LIMIT_MS) {
    await Bun.sleep(500);
    drained = await scrape(processes);
  }
  const drainSeconds = (performance.now() - drainStarted) / 1_000;

  // The only assertion: whatever happened, the books balance, and the money that moved is what the answers say moved.
  // A request the client gave up on may still have been applied, so the answers set a floor and the unanswered set
  // the room above it.
  const walletIds = `{${wallets.map((w) => w.walletId).join(",")}}`;
  let ledgerOk = true;
  for (const wallet of wallets) {
    try {
      await world.expectLedgerExplainsBalance(wallet.walletId);
    } catch {
      ledgerOk = false;
    }
  }
  const [row] = (await world.sql(
    "select (sum(balance) * 100)::bigint::text as cents from wallets where id = any(?::uuid[])",
    [walletIds],
  )) as Array<{ cents: string }>;
  const moved = BigInt(scenario.wallets) * 100_000_000n - BigInt(row?.cents ?? "0");
  const consistent =
    ledgerOk && moved >= BigInt(applied) * 100n && moved <= BigInt(applied + unanswered) * 100n;

  await cluster.stopAll();

  const ok = samples.filter((s) => s.status === 200 || s.status === 422);
  const sortedOk = ok.map((s) => s.ms).sort((a, b) => a - b);
  const byStatus: Record<string, number> = {};
  for (const s of samples) byStatus[String(s.status)] = (byStatus[String(s.status)] ?? 0) + 1;
  const failures = samples.length - ok.length;

  return {
    scenario: scenario.name,
    description: scenario.description,
    wallets: scenario.wallets,
    concurrency: CONCURRENCY,
    processes: PROCESSES,
    window_seconds: Number(seconds.toFixed(1)),
    requests: samples.length,
    throughput_per_second: Number(((byStatus["200"] ?? 0) / seconds).toFixed(1)),
    latency_ms: {
      p50: Number(percentile(sortedOk, 50).toFixed(1)),
      p95: Number(percentile(sortedOk, 95).toFixed(1)),
      p99: Number(percentile(sortedOk, 99).toFixed(1)),
      max: Number((sortedOk.at(-1) ?? Number.NaN).toFixed(1)),
    },
    by_status: byStatus,
    error_rate: Number((failures / Math.max(1, samples.length)).toFixed(4)),
    during_window: {
      lock_timeouts: afterLoad.lockTimeouts - afterWarmup.lockTimeouts,
      deadlocks: afterLoad.deadlocks - afterWarmup.deadlocks,
      transient_database_failures: afterLoad.transient - afterWarmup.transient,
      retries: afterLoad.retries - afterWarmup.retries,
    },
    outbox: {
      max_lag_seconds: Number(Math.max(0, afterLoad.lagSeconds, ...lag).toFixed(1)),
      lag_at_end_of_load_seconds: Number(afterLoad.lagSeconds.toFixed(1)),
      unpublished_at_end_of_load: afterLoad.unpublished,
      seconds_to_publish_the_backlog: Number(drainSeconds.toFixed(1)),
      unpublished_after_drain: drained.unpublished,
    },
    books_balance: ledgerOk,
    bets_answered_200: applied,
    requests_unanswered: unanswered,
    money_moved: `${moved / 100n}.${String(moved % 100n).padStart(2, "0")}`,
    consistent,
  };
}

async function main() {
  await setUpQueues();
  await setUpEventsQueue();
  const world = await SettlementWorld.create();
  const cluster = new Cluster(world);
  const results = [];
  try {
    const scenarios: Scenario[] = [
      { name: "spread", description: `${WALLETS} wallets, requests rotate over them`, wallets: WALLETS },
      { name: "hot-wallet", description: "every request on one wallet", wallets: 1 },
    ];
    for (const scenario of scenarios.filter((candidate) => !ONLY || candidate.name === ONLY)) {
      console.error(`running ${scenario.name} ...`);
      results.push(await runScenario(world, cluster, scenario));
    }
  } finally {
    await cluster.stopAll();
    await world.destroy();
  }

  const report = {
    when: new Date().toISOString(),
    environment: {
      machine: `${os.cpus()[0]?.model} x ${os.cpus().length}`,
      memory_gb: Number((os.totalmem() / 2 ** 30).toFixed(1)),
      os: `${os.type()} ${os.release()}`,
      runtime: `Bun ${Bun.version}`,
      topology:
        "application processes run natively on the host; PostgreSQL 18 and the SQS emulator run in Docker on the same machine, as does the load generator",
      application_processes: PROCESSES,
      parameters: { DURATION_S, WARMUP_S, CONCURRENCY, WALLETS },
    },
    method:
      "closed loop: each worker sends its next request when the previous one answered; no retries; latency is of answers 200 and 422; throughput is bets applied (200) per second over the window",
    results,
  };
  mkdirSync("load-results", { recursive: true });
  const file = `load-results/${report.when.replaceAll(":", "-")}.json`;
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.error(`written to ${file}`);
  if (!results.every((r) => r.consistent)) {
    console.error("THE BOOKS DID NOT BALANCE AFTER LOAD");
    process.exit(1);
  }
}

await main();
