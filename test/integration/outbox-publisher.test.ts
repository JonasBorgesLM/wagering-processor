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
import {
  DeleteMessageCommand,
  GetQueueUrlCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { QUEUES } from "../../src/platform/config/config";
import type { EventPublisher, OutboxEntry, OutboxStore } from "../../src/wagering/application/ports";
import { PublishOutbox } from "../../src/wagering/application/publish-outbox";
import { SqsEventPublisher } from "../../src/wagering/infrastructure/messaging/sqs-event-publisher";
import { MikroOrmOutboxStore } from "../../src/wagering/infrastructure/persistence/mikro-orm-outbox-store";
import { eventually, setUpQueues, sqs } from "../support/consumer-harness";
import { TEST_ENV } from "../support/env";
import { command, SettlementWorld } from "../support/settlement";

// Reading the queue to its end takes two one-second polls, so a test that reads twice outlasts the default.
setDefaultTimeout(30_000);

// Real PostgreSQL and the real events queue (FR-90, FR-91, ADR-0007, section 11).

let world: SettlementWorld;
let eventsUrl: string;
const running: Bun.Subprocess[] = [];

beforeAll(async () => {
  await setUpQueues();
  world = await SettlementWorld.create();
  eventsUrl = (await sqs.send(new GetQueueUrlCommand({ QueueName: QUEUES.events }))).QueueUrl as string;
});
afterAll(async () => {
  await purgeEvents();
  await world.destroy();
});
beforeEach(purgeEvents);
afterEach(async () => {
  for (const child of running.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
  await purgeEvents();
});

async function purgeEvents(): Promise<void> {
  await sqs.send(new PurgeQueueCommand({ QueueUrl: eventsUrl })).catch(() => undefined);
}

interface Received {
  eventId: string;
  eventType: string;
  group: string | undefined;
  body: Record<string, unknown>;
}

/** Everything in the events queue right now, deleted as it is read. */
async function drainEvents(): Promise<Received[]> {
  const all: Received[] = [];
  for (let empty = 0; empty < 2; ) {
    const received = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: eventsUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ["MessageGroupId"],
      }),
    );
    const messages = received.Messages ?? [];
    empty = messages.length === 0 ? empty + 1 : 0;
    for (const message of messages) {
      const body = JSON.parse(message.Body ?? "{}") as Record<string, unknown>;
      all.push({
        eventId: body.eventId as string,
        eventType: body.eventType as string,
        group: message.Attributes?.MessageGroupId,
        body,
      });
      await sqs.send(new DeleteMessageCommand({ QueueUrl: eventsUrl, ReceiptHandle: message.ReceiptHandle }));
    }
  }
  return all;
}

const LEASE_MS = 1_000;

function publisherOver(
  client: SQSClient = sqs,
  wrap: {
    store?: (store: OutboxStore) => OutboxStore;
    publisher?: (p: EventPublisher) => EventPublisher;
  } = {},
  options: { batchSize?: number; leaseMs?: number; retryDelayMs?: number } = {},
) {
  const store = wrap.store ? wrap.store(realStore()) : realStore();
  const publisher = wrap.publisher
    ? wrap.publisher(new SqsEventPublisher(client))
    : new SqsEventPublisher(client);
  return new PublishOutbox(store, publisher, world.clock, {
    batchSize: options.batchSize ?? 25,
    leaseMs: options.leaseMs ?? LEASE_MS,
    retryDelayMs: () => options.retryDelayMs ?? 500,
  });
}
const realStore = () => new MikroOrmOutboxStore(world.orm, world.options);

/** A wallet with one processed bet: two events in the outbox. */
async function betOnNewWallet() {
  const wallet = await world.openWallet("100.00");
  await world.useCase.execute(command(wallet));
  return wallet;
}

const outboxOf = (walletId: string) =>
  world.sql(
    "select id, attempts, published_at, next_attempt_at from outbox_messages where aggregate_id = ? order by occurred_at, id",
    [walletId],
  );

describe("publishing", () => {
  test("a settled bet's two events reach the events queue, in the wallet's group, and are marked", async () => {
    const wallet = await betOnNewWallet();
    const result = await publisherOver().runOnce();
    expect(result).toMatchObject({ claimed: 2, published: 2 });

    const events = await drainEvents();
    expect(events.map((event) => event.eventType).sort()).toEqual([
      "WagerTransactionProcessed",
      "WalletBalanceChanged",
    ]);
    for (const event of events) {
      expect(event.group).toBe(wallet.walletId);
      expect(event.body.aggregateId).toBe(wallet.walletId);
    }
    const rows = await outboxOf(wallet.walletId);
    expect(rows.map((row) => row.id).sort()).toEqual(events.map((event) => event.eventId).sort());
    for (const row of rows) {
      expect(row.published_at).not.toBeNull();
      expect(row.attempts).toBe(1);
    }
  });

  test("the message is the stored envelope, unchanged", async () => {
    const wallet = await betOnNewWallet();
    await publisherOver().runOnce();
    const [stored] = await world.sql(
      "select payload from outbox_messages where aggregate_id = ? and event_type = 'WalletBalanceChanged'",
      [wallet.walletId],
    );
    const sent = (await drainEvents()).find((event) => event.eventType === "WalletBalanceChanged");
    expect(sent?.body).toEqual(stored?.payload as Record<string, unknown>);
  });

  test("a row already published is not claimed again, and neither is one that is not due yet", async () => {
    const wallet = await betOnNewWallet();
    await publisherOver().runOnce();
    expect(await publisherOver().runOnce()).toMatchObject({ claimed: 0 });

    const later = await betOnNewWallet();
    await world.sql(
      "update outbox_messages set next_attempt_at = now() + interval '1 hour' where aggregate_id = ?",
      [later.walletId],
    );
    expect(await publisherOver().runOnce()).toMatchObject({ claimed: 0 });
    expect((await outboxOf(wallet.walletId)).every((row) => row.attempts === 1)).toBe(true);
  });
});

describe("several publishers (ADR-0007)", () => {
  test("never claim the same row: every event is published exactly once", async () => {
    const wallets = await Promise.all(Array.from({ length: 40 }, () => betOnNewWallet()));
    const expected = wallets.length * 2;

    const sent = new Map<string, number>();
    const recording = (publisher: EventPublisher): EventPublisher => ({
      publish: async (entry: OutboxEntry) => {
        sent.set(entry.id, (sent.get(entry.id) ?? 0) + 1);
        await publisher.publish(entry);
      },
    });
    const publishers = Array.from({ length: 4 }, () =>
      publisherOver(sqs, { publisher: recording }, { batchSize: 7 }),
    );
    const loops = publishers.map(async (publisher) => {
      for (let idle = 0; idle < 3; ) {
        const { claimed } = await publisher.runOnce();
        idle = claimed === 0 ? idle + 1 : 0;
      }
    });
    await Promise.all(loops);

    expect(sent.size).toBe(expected);
    expect([...sent.values()].every((count) => count === 1)).toBe(true);
    // Only these wallets': an earlier test left a row that is deliberately not due for an hour.
    const unpublished = await world.sql(
      "select count(*)::int as n from outbox_messages where published_at is null and aggregate_id = any(?::uuid[])",
      [`{${wallets.map((wallet) => wallet.walletId).join(",")}}`],
    );
    expect(unpublished[0]?.n).toBe(0);
    const events = await drainEvents();
    expect(new Set(events.map((event) => event.eventId)).size).toBe(expected);
  }, 60_000);
});

describe("a publisher that dies after the commit and before publishing", () => {
  test("its rows are invisible while the lease holds, and another publisher takes them when it ends", async () => {
    const wallet = await betOnNewWallet();

    // Publisher A claims and is killed: nothing published, nothing put back. Its claim is all that is left.
    const claimed = await realStore().claimDue(25, LEASE_MS, new Date());
    expect(claimed.filter((entry) => entry.aggregateId === wallet.walletId)).toHaveLength(2);

    expect(await publisherOver().runOnce()).toMatchObject({ claimed: 0 });
    expect(await drainEvents()).toEqual([]);

    await Bun.sleep(LEASE_MS + 200);
    expect(await publisherOver().runOnce()).toMatchObject({ claimed: 2, published: 2 });
    expect(await drainEvents()).toHaveLength(2);
    expect((await outboxOf(wallet.walletId)).map((row) => row.attempts)).toEqual([2, 2]);
  });
});

describe("the broker is away", () => {
  test("rows back off and none is lost; when it is back they publish", async () => {
    const wallets = await Promise.all(Array.from({ length: 3 }, () => betOnNewWallet()));
    const gone = new SQSClient({
      region: TEST_ENV.AWS_REGION,
      endpoint: "http://localhost:1",
      credentials: { accessKeyId: "x", secretAccessKey: "x" },
      maxAttempts: 1,
    });
    const before = new Date();

    const failed = await publisherOver(gone, {}, { retryDelayMs: 1_500 }).runOnce();
    gone.destroy();
    expect(failed.published).toBe(0);
    expect(failed.failure).toBeDefined();

    // All six rows, the one that failed and the five it never tried, are put back for later and still unpublished.
    for (const wallet of wallets) {
      for (const row of await outboxOf(wallet.walletId)) {
        expect(row.published_at).toBeNull();
        expect(row.attempts).toBe(1);
        expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(before.getTime() + 1_000);
      }
    }
    expect(await publisherOver().runOnce()).toMatchObject({ claimed: 0 });

    await Bun.sleep(1_700);
    const recovered = await publisherOver().runOnce();
    expect(recovered).toMatchObject({ claimed: 6, published: 6 });
    expect(await drainEvents()).toHaveLength(6);
  }, 30_000);
});

describe("a duplicate publication (IR-03)", () => {
  test("dies after the broker accepted and before the mark: published again, under the same eventId", async () => {
    const wallet = await betOnNewWallet();
    let crashed = false;
    const dying = (store: OutboxStore): OutboxStore => ({
      claimDue: (...args) => store.claimDue(...args),
      reschedule: (...args) => store.reschedule(...args),
      markPublished: async (...args) => {
        if (!crashed) {
          crashed = true;
          throw new Error("killed after publishing");
        }
        return store.markPublished(...args);
      },
    });

    await expect(publisherOver(sqs, { store: dying }).runOnce()).rejects.toThrow("killed after publishing");
    expect((await outboxOf(wallet.walletId)).filter((row) => row.published_at !== null)).toHaveLength(0);

    await Bun.sleep(LEASE_MS + 200);
    await publisherOver(sqs, { store: dying }).runOnce();

    const events = await drainEvents();
    const ids = events.map((event) => event.eventId);
    // Published twice, and the broker dropped the repeat because its deduplication id is the eventId. That is an
    // optimization inside a five-minute window and not the guarantee, which is the consumer's (IR-03): what must
    // hold regardless is that a repeat carries the same eventId, and that is what the ids below show.
    expect(new Set(ids).size).toBe(2);
    expect(ids).toHaveLength(2);
    expect((await outboxOf(wallet.walletId)).every((row) => row.published_at !== null)).toBe(true);
  });
});

describe("as a process (FR-81)", () => {
  function start() {
    const child = Bun.spawn(["bun", "run", "src/main.ts"], {
      env: {
        ...process.env,
        ...TEST_ENV,
        DATABASE_URL: world.databaseUrl(),
        PORT: String(20000 + Math.floor(Math.random() * 20000)),
        APP_ROLES: "publisher",
        OUTBOX_POLL_INTERVAL_MS: "100",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    running.push(child);
    return child;
  }

  test("the publisher role publishes, and SIGTERM stops it cleanly", async () => {
    const wallet = await betOnNewWallet();
    const child = start();
    await eventually(
      async () => (await outboxOf(wallet.walletId)).every((row) => row.published_at !== null),
      "the process to publish",
      15_000,
    );
    child.kill("SIGTERM");
    expect(await child.exited).toBe(143);
    expect(await new Response(child.stdout as ReadableStream).text()).toContain("Draining");
    expect(await drainEvents()).toHaveLength(2);
  }, 40_000);

  test("a process without the role leaves the outbox alone", async () => {
    const wallet = await betOnNewWallet();
    const child = Bun.spawn(["bun", "run", "src/main.ts"], {
      env: {
        ...process.env,
        ...TEST_ENV,
        DATABASE_URL: world.databaseUrl(),
        PORT: String(20000 + Math.floor(Math.random() * 20000)),
        APP_ROLES: "api,consumer",
        QUEUE_WAIT_SECONDS: "1",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    running.push(child);
    await Bun.sleep(3_000);
    expect((await outboxOf(wallet.walletId)).every((row) => row.published_at === null)).toBe(true);
  }, 20_000);
});
