import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ApplyRetention } from "../../src/wagering/application/apply-retention";
import { MikroOrmRetentionStore } from "../../src/wagering/infrastructure/persistence/mikro-orm-retention-store";
import { type RunningApp, startApp } from "../support/app";
import { SettlementWorld } from "../support/settlement";

// Requirements: FR-103, FR-104.
// The retention job against a real PostgreSQL (T-15). What matters is what it does NOT delete: an inbox row that a
// redelivery could still need, and an outbox row that has not been published.

let world: SettlementWorld;
const NOW = new Date("2026-11-07T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

beforeAll(async () => {
  world = await SettlementWorld.create();
});
afterAll(async () => {
  await world.destroy();
});
beforeEach(async () => {
  await world.sql("delete from inbox_messages");
  await world.sql("delete from outbox_messages");
});

const retention = (batchSize = 1_000) =>
  new ApplyRetention(
    new MikroOrmRetentionStore(world.orm, world.options),
    { now: () => NOW },
    { inboxDays: 21, outboxDays: 30, batchSize },
  );

async function inbox(messageId: string, receivedDaysAgo: number) {
  await world.sql(
    "insert into inbox_messages (consumer_name, message_id, payload_hash, received_at, processed_at) values (?, ?, ?, ?, ?)",
    ["wager-queue", messageId, "0".repeat(64), daysAgo(receivedDaysAgo), daysAgo(receivedDaysAgo)],
  );
}

async function outbox(id: string, occurredDaysAgo: number, publishedDaysAgo: number | undefined) {
  await world.sql(
    `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at)
     values (?, ?, 'WalletDebited', '{}'::jsonb, ?, 1, ?, ?)`,
    [
      id,
      randomUUID(),
      daysAgo(occurredDaysAgo),
      daysAgo(occurredDaysAgo),
      publishedDaysAgo === undefined ? null : daysAgo(publishedDaysAgo),
    ],
  );
}

const ids = async (table: "inbox_messages" | "outbox_messages") =>
  (
    await world.sql(
      `select ${table === "inbox_messages" ? "message_id" : "id"} as id from ${table} order by 1`,
    )
  ).map((row) => (row as { id: string }).id);

describe("the inbox (FR-103)", () => {
  test("removes rows older than the retention and keeps the ones a redelivery could still need", async () => {
    await inbox("m-old", 22);
    await inbox("m-edge-kept", 20);
    await inbox("m-new", 1);
    const result = await retention().runOnce();
    expect(result.inbox).toBe(1);
    expect(await ids("inbox_messages")).toEqual(["m-edge-kept", "m-new"]);
  });
});

describe("the outbox (FR-104)", () => {
  test("removes old published rows, and never one that was not published, however old", async () => {
    const oldPublished = randomUUID();
    const recentPublished = randomUUID();
    const oldUnpublished = randomUUID();
    await outbox(oldPublished, 60, 45);
    await outbox(recentPublished, 40, 2);
    await outbox(oldUnpublished, 90, undefined);
    const result = await retention().runOnce();
    expect(result.outbox).toBe(1);
    expect(await ids("outbox_messages")).toEqual([oldUnpublished, recentPublished].sort());
  });
});

describe("in batches", () => {
  test("a batch removes at most its size, and the job says to come back until none is left", async () => {
    for (let i = 0; i < 5; i += 1) await inbox(`m-${i}`, 40);
    const job = retention(2);
    const rounds: number[] = [];
    for (let more = true; more; ) {
      const result = await job.runOnce();
      rounds.push(result.inbox);
      more = result.more;
    }
    expect(rounds).toEqual([2, 2, 1]);
    expect(await ids("inbox_messages")).toEqual([]);
  });
});

describe("it runs in the publisher role of the real application (FR-103)", () => {
  test("old rows disappear without anyone calling the use case, and the metric counts them", async () => {
    await inbox("m-old-app", 400);
    await inbox("m-new-app", 1);
    // The default retention is 21 days against the real clock; the rows above are 400 and 1 days old.
    const app: RunningApp = await startApp(world.databaseUrl(), {
      roles: "publisher",
      env: { RETENTION_INTERVAL_MS: "100" },
    });
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && (await ids("inbox_messages")).length !== 1) await Bun.sleep(100);
      expect(await ids("inbox_messages")).toEqual(["m-new-app"]);
      const text = await (await fetch(`${app.url}/metrics`)).text();
      expect(text).toMatch(/^wagering_retention_deleted_total\{table="inbox"\} 1$/m);
    } finally {
      await app.stop();
    }
  });
});
