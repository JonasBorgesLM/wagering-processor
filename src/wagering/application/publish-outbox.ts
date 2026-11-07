import {
  type Clock,
  type EventPublisher,
  MAX_PUBLISH_BATCH,
  NO_METRICS,
  type OutboxEntry,
  type OutboxStore,
  type WageringMetrics,
} from "./ports";

export interface PublishOutboxOptions {
  /** Rows one round claims. */
  batchSize: number;
  leaseMs: number;
  /** How many lanes send at once. */
  concurrency: number;
  /** How long to leave a row alone after its `attempts`-th failure. */
  retryDelayMs(attempts: number): number;
}

export interface PublishOutboxResult {
  claimed: number;
  published: number;
  /** Rows put back for a later attempt. */
  rescheduled: number;
  /** Why the first of them was put back, if any was. */
  failure?: unknown;
}

/**
 * Splits claimed events into lanes, each a sequence of calls of at most `MAX_PUBLISH_BATCH`.
 *
 * **A wallet's events go into one lane, in the order they were claimed.** Lanes are sent at the same time, calls within
 * a lane one after the other, so two events of one wallet are never in flight together and cannot arrive out of order.
 * Wallets are spread over the lanes, the biggest first onto the emptiest, which is what makes the concurrency useful.
 * Pure, so it is tested without a database or a broker.
 */
export function planLanes(
  entries: readonly OutboxEntry[],
  concurrency: number,
  batchSize: number = MAX_PUBLISH_BATCH,
): OutboxEntry[][][] {
  const byWallet = new Map<string, OutboxEntry[]>();
  for (const entry of entries) {
    const wallet = byWallet.get(entry.aggregateId);
    if (wallet) wallet.push(entry);
    else byWallet.set(entry.aggregateId, [entry]);
  }

  const lanes: OutboxEntry[][] = Array.from({ length: Math.max(1, concurrency) }, () => []);
  const wallets = [...byWallet.values()].sort((a, b) => b.length - a.length);
  for (const wallet of wallets) {
    const emptiest = lanes.reduce((best, lane) => (lane.length < best.length ? lane : best));
    emptiest.push(...wallet);
  }

  return lanes
    .filter((lane) => lane.length > 0)
    .map((lane) => {
      const batches: OutboxEntry[][] = [];
      for (let i = 0; i < lane.length; i += batchSize) batches.push(lane.slice(i, i + batchSize));
      return batches;
    });
}

/**
 * One round of publishing (FR-90, FR-91, ADR-0007): claim, publish outside any transaction, mark.
 *
 * Every step can be interrupted without losing an event or publishing it out of the database's sight:
 * - dies after the claim: the lease runs out and another publisher claims the row;
 * - dies after the broker accepted and before the mark: the row is published again, with the same `eventId`,
 *   which consumers deduplicate on (IR-03).
 *
 * What the broker refuses, or never receives, is put back and nothing else: a refused event, and the events of its
 * wallet that come after it in the lane, which are not sent past it. A call that fails as a whole puts back its
 * entries and the rest of its lane, and the other lanes go on.
 */
export class PublishOutbox {
  constructor(
    private readonly store: OutboxStore,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly options: PublishOutboxOptions,
    private readonly metrics: WageringMetrics = NO_METRICS,
  ) {}

  async runOnce(): Promise<PublishOutboxResult> {
    const entries = await this.store.claimDue(this.options.batchSize, this.options.leaseMs, this.clock.now());
    if (entries.length === 0) return { claimed: 0, published: 0, rescheduled: 0 };

    const accepted: string[] = [];
    const putBack = new Map<string, { entry: OutboxEntry; error: unknown }>();
    const lanes = planLanes(entries, this.options.concurrency);
    await Promise.all(lanes.map((lane) => this.sendLane(lane, accepted, putBack)));

    // A failure here propagates: the events are out, the rows are not marked, and the leases will publish them again.
    if (accepted.length > 0) await this.store.markPublished(accepted, this.clock.now());

    if (putBack.size > 0) {
      const now = this.clock.now().getTime();
      await this.store.reschedule(
        [...putBack.values()].map(({ entry }) => ({
          id: entry.id,
          nextAttemptAt: new Date(now + this.options.retryDelayMs(entry.attempts)),
        })),
      );
      for (let i = 0; i < putBack.size; i++) this.metrics.retried("outbox");
    }

    const failure = putBack.size > 0 ? [...putBack.values()][0]?.error : undefined;
    return {
      claimed: entries.length,
      published: accepted.length,
      rescheduled: putBack.size,
      ...(failure === undefined ? {} : { failure }),
    };
  }

  private async sendLane(
    lane: OutboxEntry[][],
    accepted: string[],
    putBack: Map<string, { entry: OutboxEntry; error: unknown }>,
  ): Promise<void> {
    /** Wallets that had an event refused in this lane: nothing of theirs is sent after it. */
    const blocked = new Map<string, unknown>();

    for (const [index, batch] of lane.entries()) {
      const toSend: OutboxEntry[] = [];
      for (const entry of batch) {
        if (blocked.has(entry.aggregateId))
          putBack.set(entry.id, { entry, error: blocked.get(entry.aggregateId) });
        else toSend.push(entry);
      }
      if (toSend.length === 0) continue;

      let result: Awaited<ReturnType<EventPublisher["publishBatch"]>>;
      try {
        result = await this.publisher.publishBatch(toSend);
      } catch (failure) {
        // The broker is probably away for the rest of the lane as well, and each try would wait out its own timeout
        // while the leases of the others run down: put back this call and everything after it in the lane.
        for (const entry of toSend) putBack.set(entry.id, { entry, error: failure });
        for (const rest of lane.slice(index + 1).flat())
          putBack.set(rest.id, { entry: rest, error: failure });
        return;
      }

      accepted.push(...result.accepted);
      const refused = new Map(result.rejected.map(({ id, error }) => [id, error]));
      for (const entry of toSend) {
        if (!refused.has(entry.id)) continue;
        putBack.set(entry.id, { entry, error: refused.get(entry.id) });
        blocked.set(entry.aggregateId, refused.get(entry.id));
      }
    }
  }
}
