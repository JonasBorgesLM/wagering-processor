import type { Clock, RetentionStore, WageringMetrics } from "./ports";
import { NO_METRICS } from "./ports";

export interface RetentionPolicy {
  /**
   * How long an inbox row is kept after it was received. It must outlast the queue's retention (four days by default,
   * fourteen at most) plus however long a message may sit in the DLQ before a replay: the row is what turns a late
   * redelivery into a replay instead of a second settlement, so deleting it early is the one unsafe thing here.
   */
  inboxDays: number;
  /** How long a published outbox row is kept as an audit of what was sent. Unpublished rows are never deleted. */
  outboxDays: number;
  /** Rows per statement, so one pass never holds a long transaction or a long lock. */
  batchSize: number;
}

const DAY_MS = 86_400_000;

/**
 * Deletes what nobody needs any more from the two tables that grow with traffic (T-15). The ledger and the
 * transactions are the record and are not touched. It never writes anything else, and running it twice or from
 * several processes at once only deletes less the second time.
 */
export class ApplyRetention {
  constructor(
    private readonly store: RetentionStore,
    private readonly clock: Clock,
    private readonly policy: RetentionPolicy,
    private readonly metrics: WageringMetrics = NO_METRICS,
  ) {}

  /** One batch of each. `more` is whether either batch was full, as a hint to go again before sleeping. */
  async runOnce(): Promise<{ inbox: number; outbox: number; more: boolean }> {
    const now = this.clock.now().getTime();
    const { batchSize } = this.policy;
    const inbox = await this.store.deleteInboxReceivedBefore(
      new Date(now - this.policy.inboxDays * DAY_MS),
      batchSize,
    );
    const outbox = await this.store.deletePublishedOutboxBefore(
      new Date(now - this.policy.outboxDays * DAY_MS),
      batchSize,
    );
    if (inbox > 0) this.metrics.retentionDeleted("inbox", inbox);
    if (outbox > 0) this.metrics.retentionDeleted("outbox", outbox);
    return { inbox, outbox, more: inbox === batchSize || outbox === batchSize };
  }
}
