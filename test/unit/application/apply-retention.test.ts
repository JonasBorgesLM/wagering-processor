import { describe, expect, test } from "bun:test";
import { ApplyRetention } from "../../../src/wagering/application/apply-retention";
import type { RetentionStore, WageringMetrics } from "../../../src/wagering/application/ports";
import { NO_METRICS } from "../../../src/wagering/application/ports";

// Requirements: FR-103.

const NOW = new Date("2026-11-07T12:00:00.000Z");
const DAY = 86_400_000;

function setUp(removes: { inbox: number; outbox: number }) {
  const calls: Array<{ table: string; cutoff: Date; limit: number }> = [];
  const store: RetentionStore = {
    deleteInboxReceivedBefore: async (cutoff, limit) => {
      calls.push({ table: "inbox", cutoff, limit });
      return removes.inbox;
    },
    deletePublishedOutboxBefore: async (cutoff, limit) => {
      calls.push({ table: "outbox", cutoff, limit });
      return removes.outbox;
    },
  };
  const counted: Array<[string, number]> = [];
  const metrics: WageringMetrics = { ...NO_METRICS, retentionDeleted: (t, n) => counted.push([t, n]) };
  const useCase = new ApplyRetention(
    store,
    { now: () => NOW },
    { inboxDays: 21, outboxDays: 30, batchSize: 100 },
    metrics,
  );
  return { useCase, calls, counted };
}

describe("what the job asks the store to remove (FR-103)", () => {
  test("each table by its own age, in batches", async () => {
    const { useCase, calls } = setUp({ inbox: 0, outbox: 0 });
    await useCase.runOnce();
    expect(calls).toEqual([
      { table: "inbox", cutoff: new Date(NOW.getTime() - 21 * DAY), limit: 100 },
      { table: "outbox", cutoff: new Date(NOW.getTime() - 30 * DAY), limit: 100 },
    ]);
  });

  test("it counts what was removed, and says nothing about what was not", async () => {
    const { useCase, counted } = setUp({ inbox: 7, outbox: 0 });
    expect(await useCase.runOnce()).toEqual({ inbox: 7, outbox: 0, more: false });
    expect(counted).toEqual([["inbox", 7]]);
  });

  test("a full batch asks to go again at once, a partial one to sleep", async () => {
    expect((await setUp({ inbox: 100, outbox: 3 }).useCase.runOnce()).more).toBe(true);
    expect((await setUp({ inbox: 3, outbox: 100 }).useCase.runOnce()).more).toBe(true);
    expect((await setUp({ inbox: 99, outbox: 99 }).useCase.runOnce()).more).toBe(false);
  });
});
