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
import { freePort } from "../support/ports";
import { brl, command, SettlementWorld } from "../support/settlement";

// Reading the queue to its end takes two one-second polls, so a test that reads twice outlasts the default.
setDefaultTimeout(30_000);

// Requirements: FR-90, FR-91, FR-95, FR-96, IR-03.
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
  options: { batchSize?: number; leaseMs?: number; retryDelayMs?: number; concurrency?: number } = {},
) {
  const store = wrap.store ? wrap.store(realStore()) : realStore();
  const publisher = wrap.publisher
    ? wrap.publisher(new SqsEventPublisher(client))
    : new SqsEventPublisher(client);
  return new PublishOutbox(store, publisher, world.clock, {
    batchSize: options.batchSize ?? 25,
    concurrency: options.concurrency ?? 4,
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
      publishBatch: async (entries: readonly OutboxEntry[]) => {
        for (const entry of entries) sent.set(entry.id, (sent.get(entry.id) ?? 0) + 1);
        return publisher.publishBatch(entries);
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

describe("a publisher does not wait for rows another one is claiming (ADR-0007)", () => {
  // SKIP LOCKED is not what keeps two publishers off the same row: after waiting on the lock, the second would
  // re-read the row, find the first one's lease on it and pass it by, and the test above stays green without it
  // (the mutation run found that). What it buys is that the second does not wait at all, so a slow claim in one
  // process cannot hold up publishing in the others.
  test("a claim over rows another transaction holds returns the rest at once", async () => {
    const wallets = await Promise.all(Array.from({ length: 3 }, () => betOnNewWallet()));
    const mine = wallets.map((wallet) => wallet.walletId);
    const [held] = (await world.sql(
      "select id from outbox_messages where published_at is null and aggregate_id = any(?::uuid[]) order by id limit 1",
      [`{${mine.join(",")}}`],
    )) as Array<{ id: string }>;
    if (!held) throw new Error("no row to hold");

    let holding!: () => void;
    const isHeld = new Promise<void>((resolve) => {
      holding = resolve;
    });
    let release!: () => void;
    const mayRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = world.orm.em.transactional(async (em) => {
      await em
        .getConnection()
        .execute(
          "select id from outbox_messages where id = ? for update",
          [held.id],
          "all",
          em.getTransactionContext(),
        );
      holding();
      await mayRelease;
    });
    try {
      await isHeld;
      const started = performance.now();
      const claimed = await realStore().claimDue(100, 60_000, new Date());
      const took = performance.now() - started;
      const ids = claimed.map((entry) => entry.id);
      expect(ids).not.toContain(held.id);
      // The other five rows of these wallets were free to take.
      expect(claimed.filter((entry) => mine.includes(entry.aggregateId)).length).toBe(5);
      expect(took).toBeLessThan(1_000);
    } finally {
      release();
      await holder;
      // Later tests assume nothing else is due, and this one leaves rows leased or unclaimed.
      await world.sql("delete from outbox_messages where aggregate_id = any(?::uuid[])", [
        `{${mine.join(",")}}`,
      ]);
    }
  });
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

describe("batched, concurrent publishing (issue #51)", () => {
  /** A wallet with `bets` processed bets: two events each, in a known order. */
  const walletWithBets = async (bets: number) => {
    const wallet = await world.openWallet("1000.00");
    for (let i = 0; i < bets; i++) await world.useCase.execute(command(wallet, { money: brl("1.00") }));
    return wallet;
  };

  test("a wallet's events reach the queue in the order they happened, though sent in parallel", async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => walletWithBets(20)));
    const publisher = publisherOver(sqs, {}, { batchSize: 500, concurrency: 4 });
    for (let idle = 0; idle < 2; ) idle = (await publisher.runOnce()).claimed === 0 ? idle + 1 : 0;

    const events = await drainEvents();
    for (const wallet of wallets) {
      const mine = events.filter((event) => event.group === wallet.walletId);
      expect(mine).toHaveLength(40);
      // The balance changes carry the wallet's version: published in order, they rise one by one.
      const versions = mine
        .filter((event) => event.eventType === "WalletBalanceChanged")
        .map((event) => (event.body.data as { walletVersion: number }).walletVersion);
      expect(versions).toEqual(Array.from({ length: 20 }, (_, i) => i + 2));
    }
  }, 60_000);

  test("sends ten to a call at most, and several calls at once, never two of one wallet together", async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => walletWithBets(15)));
    const mine = new Set(wallets.map((wallet) => wallet.walletId));
    let inFlight = 0;
    let mostInFlight = 0;
    let biggestCall = 0;
    const together: string[] = [];
    const active = new Map<string, number>();
    const watching = (inner: EventPublisher): EventPublisher => ({
      publishBatch: async (entries) => {
        if (!entries.some((entry) => mine.has(entry.aggregateId))) return inner.publishBatch(entries);
        biggestCall = Math.max(biggestCall, entries.length);
        inFlight++;
        mostInFlight = Math.max(mostInFlight, inFlight);
        const wallets = new Set(entries.map((entry) => entry.aggregateId));
        for (const wallet of wallets) {
          if ((active.get(wallet) ?? 0) > 0) together.push(wallet);
          active.set(wallet, (active.get(wallet) ?? 0) + 1);
        }
        try {
          return await inner.publishBatch(entries);
        } finally {
          inFlight--;
          for (const wallet of wallets) active.set(wallet, (active.get(wallet) ?? 1) - 1);
        }
      },
    });
    const publisher = publisherOver(sqs, { publisher: watching }, { batchSize: 500, concurrency: 4 });
    for (let idle = 0; idle < 2; ) idle = (await publisher.runOnce()).claimed === 0 ? idle + 1 : 0;

    expect(biggestCall).toBeLessThanOrEqual(10);
    expect(biggestCall).toBeGreaterThan(1);
    expect(mostInFlight).toBeGreaterThan(1);
    expect(together).toEqual([]);
    expect((await drainEvents()).filter((event) => mine.has(event.group as string))).toHaveLength(8 * 15 * 2);
  }, 60_000);

  test("what the broker refuses is put back, and the wallet's events in later calls wait behind it", async () => {
    // Twelve bets: 24 events, so the wallet's events span three calls of ten, ten and four, in one lane.
    const wallet = await walletWithBets(12);
    const rows = await outboxOf(wallet.walletId);
    expect(rows).toHaveLength(24);
    const refusedId = rows[2]?.id as string;

    let refuse = true;
    const refusing = (inner: EventPublisher): EventPublisher => ({
      publishBatch: async (entries) => {
        if (!refuse || !entries.some((entry) => entry.id === refusedId)) return inner.publishBatch(entries);
        const rest = entries.filter((entry) => entry.id !== refusedId);
        const sent = await inner.publishBatch(rest);
        return { ...sent, rejected: [{ id: refusedId, error: new Error("refused") }] };
      },
    });
    const publisher = publisherOver(
      sqs,
      { publisher: refusing },
      { batchSize: 100, concurrency: 1, retryDelayMs: 300 },
    );

    // Nine of the first call went with it (the broker took them in the same call and cannot take them back). The
    // refused one is put back, and so is everything of the wallet in the two calls after it, which are not sent past it.
    expect(await publisher.runOnce()).toMatchObject({ claimed: 24, published: 9, rescheduled: 15 });
    const unpublished = (await outboxOf(wallet.walletId)).filter((row) => row.published_at === null);
    expect(unpublished.map((row) => row.id)).toEqual([
      refusedId,
      ...rows.slice(10).map((row) => row.id as string),
    ]);

    refuse = false;
    await Bun.sleep(400);
    expect(await publisher.runOnce()).toMatchObject({ claimed: 15, published: 15, rescheduled: 0 });

    const arrived = (await drainEvents())
      .filter((event) => event.group === wallet.walletId)
      .map((event) => event.eventId);
    expect(new Set(arrived).size).toBe(24);
    // What was blocked behind the refused event arrived after it, and in its own order.
    const at = (id: string) => arrived.indexOf(id);
    expect(at(refusedId)).toBeGreaterThan(at(rows[9]?.id as string));
    for (const later of rows.slice(10)) expect(at(later.id as string)).toBeGreaterThan(at(refusedId));
    expect(rows.slice(10).map((row) => at(row.id as string))).toEqual(
      [...rows.slice(10).map((row) => at(row.id as string))].sort((x, y) => x - y),
    );
    expect((await outboxOf(wallet.walletId)).every((row) => row.published_at !== null)).toBe(true);
  }, 30_000);

  test("a call that fails as a whole puts back its entries and the rest of its lane, and the other lanes go on", async () => {
    const wallets = await Promise.all(Array.from({ length: 4 }, () => walletWithBets(3)));
    const victim = wallets[0]?.walletId as string;
    const failing = (inner: EventPublisher): EventPublisher => ({
      publishBatch: async (entries) => {
        if (entries.some((entry) => entry.aggregateId === victim)) throw new Error("the call failed");
        return inner.publishBatch(entries);
      },
    });
    const publisher = publisherOver(
      sqs,
      { publisher: failing },
      { batchSize: 100, concurrency: 4, retryDelayMs: 60_000 },
    );
    const result = await publisher.runOnce();

    expect(result.failure).toBeInstanceOf(Error);
    // Everything in the victim's lane waits; the wallets in the other lanes were published.
    const publishedWallets = new Set<string>();
    for (const wallet of wallets) {
      const rows = await outboxOf(wallet.walletId);
      if (rows.every((row) => row.published_at !== null)) publishedWallets.add(wallet.walletId);
      else expect(rows.every((row) => row.published_at === null)).toBe(true);
    }
    expect(publishedWallets.has(victim)).toBe(false);
    expect(publishedWallets.size).toBeGreaterThanOrEqual(1);
    expect(result.published + result.rescheduled).toBe(result.claimed);
  }, 30_000);
});

describe("the store writes many rows at once (issue #51)", () => {
  test("marks published only what is unpublished, and puts back each row at its own time", async () => {
    const wallet = await betOnNewWallet();
    const [first, second] = await outboxOf(wallet.walletId);
    const store = realStore();

    const firstMark = new Date("2026-01-01T00:00:00Z");
    await store.markPublished([first?.id as string], firstMark);
    // Marked again by another publisher whose lease ran out: the first mark stands.
    await store.markPublished([first?.id as string, second?.id as string], new Date("2026-02-02T00:00:00Z"));
    const rows = await world.sql(
      "select id, published_at from outbox_messages where aggregate_id = ? order by occurred_at, id",
      [wallet.walletId],
    );
    expect(new Date(rows[0]?.published_at).toISOString()).toBe(firstMark.toISOString());
    expect(new Date(rows[1]?.published_at).toISOString()).toBe("2026-02-02T00:00:00.000Z");

    // A published row is not put back; an unpublished one goes to its own time.
    const other = await betOnNewWallet();
    const [a, b] = await outboxOf(other.walletId);
    await store.markPublished([a?.id as string], new Date());
    await store.reschedule([
      { id: a?.id as string, nextAttemptAt: new Date("2030-01-01T00:00:00Z") },
      { id: b?.id as string, nextAttemptAt: new Date("2031-01-01T00:00:00Z") },
    ]);
    const after = await world.sql(
      "select id, next_attempt_at from outbox_messages where aggregate_id = ? order by occurred_at, id",
      [other.walletId],
    );
    expect(new Date(after[0]?.next_attempt_at).getFullYear()).not.toBe(2030);
    expect(new Date(after[1]?.next_attempt_at).toISOString()).toBe("2031-01-01T00:00:00.000Z");
  });

  test("nothing to mark and nothing to put back are no statements", async () => {
    await realStore().markPublished([], new Date());
    await realStore().reschedule([]);
  });
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
        PORT: String(freePort()),
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
        PORT: String(freePort()),
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
