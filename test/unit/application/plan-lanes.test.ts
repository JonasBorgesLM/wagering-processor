import { describe, expect, test } from "bun:test";
import type { OutboxEntry } from "../../../src/wagering/application/ports";
import { planLanes } from "../../../src/wagering/application/publish-outbox";

// Requirements: FR-95, FR-96. How claimed events are laid out for sending: a wallet's events in one lane, in order,
// so that two of them are never in flight together; lanes spread over the concurrency; calls of at most ten.

const entry = (wallet: string, n: number): OutboxEntry => ({
  id: `${wallet}-${n}`,
  aggregateId: wallet,
  eventType: "X",
  payload: {},
  attempts: 1,
});
const events = (wallet: string, count: number) => Array.from({ length: count }, (_, n) => entry(wallet, n));

describe("laying out claimed events for sending", () => {
  test("a wallet's events are in one lane, in the order they were claimed", () => {
    const claimed = [...events("a", 25), ...events("b", 25), ...events("c", 25)];
    // Interleaved as the database would return them, which must not matter to the order within a wallet.
    const interleaved = claimed.sort((x, y) => Number(x.id.split("-")[1]) - Number(y.id.split("-")[1]));
    const lanes = planLanes(interleaved, 4);

    for (const wallet of ["a", "b", "c"]) {
      const holding = lanes.filter((lane) => lane.flat().some((e) => e.aggregateId === wallet));
      expect(holding, `${wallet} spread over lanes`).toHaveLength(1);
      const order = (holding[0] ?? [])
        .flat()
        .filter((e) => e.aggregateId === wallet)
        .map((e) => Number(e.id.split("-")[1]));
      expect(order).toEqual([...order].sort((p, q) => p - q));
    }
  });

  test("no call carries more than ten", () => {
    const lanes = planLanes(events("a", 95), 4);
    for (const lane of lanes) for (const batch of lane) expect(batch.length).toBeLessThanOrEqual(10);
    expect(lanes.flat(2)).toHaveLength(95);
  });

  test("every claimed event is sent exactly once", () => {
    const claimed = [...events("a", 7), ...events("b", 13), ...events("c", 1), ...events("d", 30)];
    const sent = planLanes(claimed, 3)
      .flat(2)
      .map((e) => e.id);
    expect(sent.sort()).toEqual(claimed.map((e) => e.id).sort());
  });

  test("wallets are spread over the lanes, so the concurrency is used", () => {
    const claimed = ["a", "b", "c", "d"].flatMap((wallet) => events(wallet, 10));
    const lanes = planLanes(claimed, 4);
    expect(lanes).toHaveLength(4);
    expect(lanes.map((lane) => lane.flat().length)).toEqual([10, 10, 10, 10]);
  });

  test("the biggest wallet goes first and the rest fill the emptiest lane", () => {
    const lanes = planLanes([...events("small", 2), ...events("big", 30), ...events("mid", 5)], 2);
    const sizes = lanes.map((lane) => lane.flat().length).sort((a, b) => a - b);
    expect(sizes).toEqual([7, 30]);
  });

  test("one wallet cannot use more than one lane, however many events it has", () => {
    expect(planLanes(events("only", 50), 8)).toHaveLength(1);
  });

  test("nothing claimed is nothing to send, and a concurrency below one is one lane", () => {
    expect(planLanes([], 4)).toEqual([]);
    expect(planLanes(events("a", 3), 0)).toHaveLength(1);
  });
});
