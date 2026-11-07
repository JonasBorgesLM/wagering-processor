import { type Clock, type EventPublisher, NO_METRICS, type OutboxStore, type WageringMetrics } from "./ports";

export interface PublishOutboxOptions {
  batchSize: number;
  leaseMs: number;
  /** How long to leave a row alone after its `attempts`-th failure. */
  retryDelayMs(attempts: number): number;
}

export interface PublishOutboxResult {
  claimed: number;
  published: number;
  /** Why the batch stopped early, if it did. */
  failure?: unknown;
}

/**
 * One round of publishing (FR-90, FR-91, ADR-0007): claim, publish outside any transaction, mark.
 *
 * Every step can be interrupted without losing an event or publishing it out of the database's sight:
 * - dies after the claim: the lease runs out and another publisher claims the row;
 * - dies after the broker accepted and before the mark: the row is published again, with the same `eventId`,
 *   which consumers deduplicate on (IR-03).
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
    let published = 0;

    for (const [index, entry] of entries.entries()) {
      try {
        await this.publisher.publish(entry);
      } catch (failure) {
        // The broker is probably away for the rest as well, and each try would wait out its own timeout while the
        // lease of the others runs down. So the failed row and the unattempted rest are put back together, which
        // also keeps a wallet's events in the order they were claimed.
        for (const rest of entries.slice(index)) {
          const retryAt = new Date(this.clock.now().getTime() + this.options.retryDelayMs(rest.attempts));
          await this.store.reschedule(rest.id, retryAt);
          this.metrics.retried("outbox");
        }
        return { claimed: entries.length, published, failure };
      }
      // A failure here propagates: the event is out, the row is not marked, and the lease will publish it again.
      await this.store.markPublished(entry.id, this.clock.now());
      published += 1;
    }
    return { claimed: entries.length, published };
  }
}
