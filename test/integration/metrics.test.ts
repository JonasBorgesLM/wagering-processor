import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { SQSClient } from "@aws-sdk/client-sqs";
import { Registry } from "prom-client";
import { DuplicateOperationError, TransientFailureError } from "../../src/wagering/application/errors";
import { PublishOutbox } from "../../src/wagering/application/publish-outbox";
import { SettleWaitingReferences } from "../../src/wagering/application/settle-waiting-references";
import { SubmitWagerTransaction } from "../../src/wagering/application/submit-wager-transaction";
import { WagerTransactionKind as Kind } from "../../src/wagering/domain/wager-transaction";
import { SqsEventPublisher } from "../../src/wagering/infrastructure/messaging/sqs-event-publisher";
import { WagerQueueConsumer } from "../../src/wagering/infrastructure/messaging/wager-queue-consumer";
import {
  PrometheusMetrics,
  registerOutboxGauges,
} from "../../src/wagering/infrastructure/metrics/prometheus-metrics";
import { measureOutbox } from "../../src/wagering/infrastructure/persistence/mikro-orm-outbox-lag";
import { MikroOrmOutboxStore } from "../../src/wagering/infrastructure/persistence/mikro-orm-outbox-store";
import { MikroOrmPendingReferenceStore } from "../../src/wagering/infrastructure/persistence/mikro-orm-pending-reference-store";
import { MikroOrmUnitOfWork } from "../../src/wagering/infrastructure/persistence/mikro-orm-unit-of-work";
import { type RunningApp, startApp } from "../support/app";
import {
  deadLetterUrl,
  depth,
  eventually,
  FAST,
  message,
  purge,
  queueIsEmpty,
  send,
  setUpQueues,
  sqs,
  started,
} from "../support/consumer-harness";
import { TEST_ENV } from "../support/env";
import { call } from "../support/http";
import { brl, command, deferred, instrumented, SettlementWorld } from "../support/settlement";

// Every metric of NFR-06 moves in a test that causes it, on real PostgreSQL and a real broker. Each test reads the
// registry before and after, so what it asserts is the change it caused and not the state earlier tests left.

setDefaultTimeout(30_000);

let world: SettlementWorld;
let registry: Registry;
let metrics: PrometheusMetrics;

/** A world whose database failures are counted in the registry under test. */
beforeAll(async () => {
  await setUpQueues();
  registry = new Registry();
  metrics = new PrometheusMetrics(registry);
  world = await SettlementWorld.create({
    lockTimeoutMs: 300,
    statementTimeoutMs: 5_000,
    onTransientFailure: (reason) => metrics.databaseTransient(reason),
  });
});
afterAll(async () => {
  await purge();
  sqs.destroy();
  await world.destroy();
});
beforeEach(purge);
afterEach(purge);

async function sample(name: string, labels: Record<string, string> = {}): Promise<number> {
  const text = await registry.metrics();
  // A series that has never been touched is not there, which is a count of zero.
  const line = text
    .split("\n")
    .find((l) =>
      l.startsWith(`${name}{`) || l.startsWith(`${name} `)
        ? Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`))
        : false,
    );
  return line ? Number(line.split(" ").at(-1)) : 0;
}

/** How much `work` changed a series. */
async function change(
  name: string,
  labels: Record<string, string>,
  work: () => Promise<unknown>,
): Promise<number> {
  const before = await sample(name, labels);
  await work();
  return (await sample(name, labels)) - before;
}

function useCase(unitOfWork = world.unitOfWork) {
  return new SubmitWagerTransaction(
    unitOfWork,
    world.clock,
    world.ids,
    { firstReferenceRetryMs: 5_000 },
    metrics,
  );
}

describe("transactions by status", () => {
  test.each([
    ["PROCESSED", async (w: Wallet) => useCase().execute(command(w))],
    ["REJECTED", async (w: Wallet) => useCase().execute(command(w, { money: brl("500.00") }))],
    [
      "PENDING_REFERENCE",
      async (w: Wallet) =>
        useCase().execute(
          command(w, { kind: Kind.Rollback, referenceExternalTransactionId: "not-yet", money: brl("1.00") }),
        ),
    ],
  ])("a transaction that ends %s is counted under it", async (status, run) => {
    const wallet = await world.openWallet("100.00");
    const kind = status === "PENDING_REFERENCE" ? "ROLLBACK" : "BET";
    const delta = await change("wagering_transactions_total", { status, kind, source: "http" }, () =>
      run(wallet),
    );
    expect(delta).toBe(1);
  });

  test("by where it came from: over the queue it is sqs", async () => {
    const wallet = await world.openWallet("100.00");
    const delta = await change(
      "wagering_transactions_total",
      { status: "PROCESSED", kind: "BET", source: "sqs" },
      () => useCase().execute(command(wallet), { consumerName: "c", messageId: randomUUID() }),
    );
    expect(delta).toBe(1);
  });

  test("a replay is not a new transaction", async () => {
    const wallet = await world.openWallet("100.00");
    const operation = command(wallet);
    await useCase().execute(operation);
    const delta = await change(
      "wagering_transactions_total",
      { status: "PROCESSED", kind: "BET", source: "http" },
      () => useCase().execute(operation),
    );
    expect(delta).toBe(0);
  });

  test("a waiting transaction that the worker settles is counted under the worker", async () => {
    const wallet = await world.openWallet("100.00");
    const bet = command(wallet);
    const refund = await useCase().execute(
      command(wallet, { kind: Kind.Refund, referenceExternalTransactionId: bet.externalTransactionId }),
    );
    await useCase().execute(bet);
    await world.sql(
      "update wager_transactions set next_retry_at = now() - interval '1 second' where id = ?",
      [refund.transactionId],
    );
    const worker = new SettleWaitingReferences(
      new MikroOrmPendingReferenceStore(world.orm, world.options),
      world.unitOfWork,
      world.clock,
      world.ids,
      { batchSize: 25, leaseMs: 1_000, ttlMs: 3_600_000, retryDelayMs: () => 60_000 },
      metrics,
    );
    const delta = await change(
      "wagering_transactions_total",
      { status: "PROCESSED", kind: "REFUND", source: "reference_worker" },
      () => worker.runOnce(),
    );
    expect(delta).toBe(1);
  });
});

type Wallet = { walletId: string; playerId: string };

describe("duplicates detected", () => {
  test("a replay", async () => {
    const wallet = await world.openWallet("100.00");
    const operation = command(wallet);
    await useCase().execute(operation);
    expect(
      await change("wagering_duplicates_total", { kind: "replay" }, () => useCase().execute(operation)),
    ).toBe(1);
  });

  test("a key reused with another payload", async () => {
    const wallet = await world.openWallet("100.00");
    const operation = command(wallet);
    await useCase().execute(operation);
    const delta = await change("wagering_duplicates_total", { kind: "idempotency_conflict" }, () =>
      useCase()
        .execute({ ...operation, money: brl("1.00") })
        .catch(() => undefined),
    );
    expect(delta).toBe(1);
  });

  test("an external id under another key", async () => {
    const wallet = await world.openWallet("100.00");
    const operation = command(wallet);
    await useCase().execute(operation);
    const delta = await change("wagering_duplicates_total", { kind: "external_id_conflict" }, () =>
      useCase()
        .execute({ ...operation, idempotencyKey: `other-${randomUUID()}` })
        .catch(() => undefined),
    );
    expect(delta).toBe(1);
  });

  test("a message id reused with other content", async () => {
    const wallet = await world.openWallet("100.00");
    const id = randomUUID();
    await useCase().execute(command(wallet), { consumerName: "c", messageId: id });
    const delta = await change("wagering_duplicates_total", { kind: "message_id_conflict" }, () =>
      useCase()
        .execute(command(wallet, { money: brl("2.00") }), { consumerName: "c", messageId: id })
        .catch(() => undefined),
    );
    expect(delta).toBe(1);
  });
});

describe("processing latency", () => {
  test("a settlement is timed by where it came from and how it ended", async () => {
    const wallet = await world.openWallet("100.00");
    const operation = command(wallet);
    const decided = await change(
      "wagering_settlement_duration_seconds_count",
      { source: "http", outcome: "decided" },
      () => useCase().execute(operation),
    );
    const replay = await change(
      "wagering_settlement_duration_seconds_count",
      { source: "http", outcome: "replay" },
      () => useCase().execute(operation),
    );
    const error = await change(
      "wagering_settlement_duration_seconds_count",
      { source: "http", outcome: "error" },
      () =>
        useCase()
          .execute({ ...operation, money: brl("1.00") })
          .catch(() => undefined),
    );
    const queue = await change(
      "wagering_settlement_duration_seconds_count",
      { source: "sqs", outcome: "decided" },
      () => useCase().execute(command(wallet), { consumerName: "c", messageId: randomUUID() }),
    );
    expect([decided, replay, error, queue]).toEqual([1, 1, 1, 1]);
    expect(
      await sample("wagering_settlement_duration_seconds_sum", { source: "http", outcome: "decided" }),
    ).toBeGreaterThan(0);
  });
});

describe("lock conflicts", () => {
  test("a wait for a lock that runs out is a lock timeout, counted as a conflict and as a transient failure", async () => {
    const wallet = await world.openWallet("100.00");
    const release = await world.holdLock(wallet.walletId);
    try {
      const conflicts = await change("wagering_lock_conflicts_total", { kind: "lock_timeout" }, async () => {
        await expect(useCase().execute(command(wallet))).rejects.toThrow(TransientFailureError);
      });
      expect(conflicts).toBe(1);
    } finally {
      await release();
    }
    expect(
      await sample("wagering_database_transient_failures_total", { reason: "lock_timeout" }),
    ).toBeGreaterThanOrEqual(1);
  });

  test("a deadlock is counted as a conflict", async () => {
    const a = await world.openWallet("100.00");
    const b = await world.openWallet("100.00");
    const bothHoldOne = { count: 0, ready: deferred() };
    // The lock timeout of this world (300 ms) is shorter than PostgreSQL's deadlock detection (1 s), so the
    // transactions here would time out first. Patient ones let the deadlock be what ends.
    const patient = new MikroOrmUnitOfWork(world.orm, world.clock, {
      lockTimeoutMs: 5_000,
      statementTimeoutMs: 8_000,
      onTransientFailure: (reason) => metrics.databaseTransient(reason),
    });
    const lockBoth = (first: string, second: string) =>
      patient.run(async (tx) => {
        await tx.wallets.lockById(first);
        if (++bothHoldOne.count === 2) bothHoldOne.ready.resolve();
        await bothHoldOne.ready.promise;
        await tx.wallets.lockById(second);
      });
    const delta = await change("wagering_lock_conflicts_total", { kind: "deadlock" }, async () => {
      await Promise.allSettled([lockBoth(a.walletId, b.walletId), lockBoth(b.walletId, a.walletId)]);
    });
    expect(delta).toBe(1);
  });
});

describe("retries", () => {
  test("the consumer puts a transient failure back", async () => {
    const wallet = await world.openWallet("100.00");
    const throwing = {
      execute: async () => {
        throw new TransientFailureError("away");
      },
    } as unknown as SubmitWagerTransaction;
    const consumer = started(new WagerQueueConsumer(sqs, throwing, FAST, undefined, metrics));
    try {
      const delta = await change("wagering_retries_total", { component: "consumer" }, async () => {
        await send(message(wallet), wallet.walletId);
        await eventually(
          async () => (await sample("wagering_retries_total", { component: "consumer" })) > 0,
          "a retry",
        );
      });
      expect(delta).toBeGreaterThanOrEqual(1);
    } finally {
      await consumer.beforeApplicationShutdown();
    }
  });

  test("the publisher puts events back when the broker is away", async () => {
    await world.openWallet("100.00").then((w) => useCase().execute(command(w)));
    const gone = new SQSClient({
      region: TEST_ENV.AWS_REGION,
      endpoint: "http://localhost:1",
      credentials: { accessKeyId: "x", secretAccessKey: "x" },
      maxAttempts: 1,
    });
    const publish = new PublishOutbox(
      new MikroOrmOutboxStore(world.orm, world.options),
      new SqsEventPublisher(gone),
      world.clock,
      { batchSize: 25, leaseMs: 1_000, retryDelayMs: () => 60_000 },
      metrics,
    );
    const delta = await change("wagering_retries_total", { component: "outbox" }, () => publish.runOnce());
    gone.destroy();
    expect(delta).toBeGreaterThanOrEqual(2);
  });

  test("the reference worker looks again at a transaction still waiting", async () => {
    const wallet = await world.openWallet("100.00");
    const waiting = await useCase().execute(
      command(wallet, { kind: Kind.Rollback, referenceExternalTransactionId: "later", money: brl("1.00") }),
    );
    await world.sql(
      "update wager_transactions set next_retry_at = now() - interval '1 second' where id = ?",
      [waiting.transactionId],
    );
    const worker = new SettleWaitingReferences(
      new MikroOrmPendingReferenceStore(world.orm, world.options),
      world.unitOfWork,
      world.clock,
      world.ids,
      { batchSize: 25, leaseMs: 1_000, ttlMs: 3_600_000, retryDelayMs: () => 60_000 },
      metrics,
    );
    expect(
      await change("wagering_retries_total", { component: "reference_worker" }, () => worker.runOnce()),
    ).toBe(1);
  });

  test("the settlement starts over when it loses a race on a unique key", async () => {
    const wallet = await world.openWallet("100.00");
    let raised = false;
    const racing = instrumented(world.unitOfWork, (call, phase) => {
      if (call === "transactions.insert" && phase === "before" && !raised) {
        raised = true;
        throw new DuplicateOperationError("lost the race");
      }
    });
    const delta = await change("wagering_retries_total", { component: "duplicate_race" }, () =>
      useCase(racing).execute(command(wallet)),
    );
    expect(delta).toBe(1);
  });
});

describe("messages in the dead-letter queue", () => {
  const brokenUseCase = {
    execute: async () => {
      throw new TransientFailureError("still away");
    },
  } as unknown as SubmitWagerTransaction;

  test("a permanent failure is counted as permanent", async () => {
    const wallet = await world.openWallet("100.00");
    const consumer = started(new WagerQueueConsumer(sqs, useCase(), FAST, undefined, metrics));
    try {
      const delta = await change("wagering_dlq_messages_total", { reason: "permanent" }, async () => {
        await send("{not json", wallet.walletId);
        await eventually(async () => (await depth(deadLetterUrl)).visible === 1, "the DLQ");
      });
      expect(delta).toBe(1);
    } finally {
      await consumer.beforeApplicationShutdown();
    }
  });

  test("a message whose deliveries ran out is counted as such", async () => {
    const wallet = await world.openWallet("100.00");
    const consumer = started(
      new WagerQueueConsumer(sqs, brokenUseCase, { ...FAST, maxReceives: 2 }, undefined, metrics),
    );
    try {
      const delta = await change(
        "wagering_dlq_messages_total",
        { reason: "attempts-exhausted" },
        async () => {
          await send(message(wallet), wallet.walletId);
          await eventually(async () => (await depth(deadLetterUrl)).visible === 1, "the DLQ", 20_000);
          await eventually(queueIsEmpty, "the queue to empty");
        },
      );
      expect(delta).toBe(1);
    } finally {
      await consumer.beforeApplicationShutdown();
    }
  }, 40_000);
});

describe("outbox lag", () => {
  test("grows while events wait and is back to zero when they are published", async () => {
    registerOutboxGauges(registry, measureOutbox(world.orm, world.options));
    // Start from nothing waiting, so the numbers belong to this test: earlier tests left events that are not due.
    await world.sql("update outbox_messages set published_at = now() where published_at is null");
    const publish = new PublishOutbox(
      new MikroOrmOutboxStore(world.orm, world.options),
      new SqsEventPublisher(sqs),
      world.clock,
      { batchSize: 500, leaseMs: 1_000, retryDelayMs: () => 500 },
      metrics,
    );
    expect(await sample("wagering_outbox_unpublished")).toBe(0);
    expect(await sample("wagering_outbox_lag_seconds")).toBe(0);

    const wallet = await world.openWallet("100.00");
    await useCase().execute(command(wallet));
    await Bun.sleep(1_100);
    expect(await sample("wagering_outbox_unpublished")).toBe(2);
    expect(await sample("wagering_outbox_lag_seconds")).toBeGreaterThan(1);

    await publish.runOnce();
    expect(await sample("wagering_outbox_unpublished")).toBe(0);
    expect(await sample("wagering_outbox_lag_seconds")).toBe(0);
  });
});

describe("served by the application", () => {
  let app: RunningApp;
  beforeAll(async () => {
    app = await startApp(world.databaseUrl(), { roles: "api" });
  });
  afterAll(() => app.stop());

  test("every series of NFR-06 is there from the start, and a request moves them", async () => {
    const wallet = await world.openWallet("100.00");
    const scrape = async () => (await call(`${app.url}/metrics`)).text();
    const before = await scrape();
    for (const name of [
      "wagering_transactions_total",
      "wagering_duplicates_total",
      "wagering_retries_total",
      "wagering_dlq_messages_total",
      "wagering_lock_conflicts_total",
      "wagering_outbox_lag_seconds",
      "wagering_settlement_duration_seconds",
    ]) {
      expect(before, name).toContain(`# TYPE ${name} `);
    }
    expect(before).toContain('wagering_dlq_messages_total{reason="permanent"} 0');

    const operation = command(wallet);
    const body = {
      providerId: operation.providerId,
      externalTransactionId: operation.externalTransactionId,
      playerId: operation.playerId,
      walletId: operation.walletId,
      roundId: operation.roundId,
      gameId: operation.gameId,
      kind: "BET",
      money: { amount: "10.00", currency: "BRL" },
    };
    const headers = { "content-type": "application/json", "idempotency-key": operation.idempotencyKey };
    const post = () =>
      call(`${app.url}/wagering/transactions`, { method: "POST", headers, body: JSON.stringify(body) });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);

    const after = await scrape();
    expect(after).toContain('wagering_transactions_total{status="PROCESSED",kind="BET",source="http"} 1');
    expect(after).toContain('wagering_duplicates_total{kind="replay"} 1');
    expect(after).toMatch(/wagering_settlement_duration_seconds_count\{source="http",outcome="decided"\} 1/);
  });
});
