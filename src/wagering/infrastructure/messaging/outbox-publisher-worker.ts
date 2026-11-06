import { type BeforeApplicationShutdown, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import type { PublishOutbox } from "../../application/publish-outbox";

/**
 * Runs `PublishOutbox` for as long as the process lives (FR-90). Several of these, in several processes, are
 * safe: the lease is what keeps them from taking the same rows (ADR-0007).
 *
 * Stopping waits for the round in progress, which is bounded by the broker timeout, so what it claimed is
 * published or put back and not left to its lease (FR-81).
 */
export class OutboxPublisherWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(
    private readonly publishOutbox: PublishOutbox,
    private readonly pollIntervalMs: number,
    private readonly drain: { begin(signal?: string): void } = { begin: () => undefined },
  ) {}

  onApplicationBootstrap(): void {
    this.loop = this.run();
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.drain.begin(signal);
    this.abort.abort();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.abort.signal.aborted) {
      let more = false;
      try {
        const result = await this.publishOutbox.runOnce();
        if (result.published > 0) this.logger.log(`Published ${result.published} event(s)`);
        if (result.failure !== undefined) {
          this.logger.warn("Publishing failed; the events will be retried later", {
            error: describe(result.failure),
          });
        } else {
          // A full batch means there is probably more: go again at once instead of sleeping on a backlog.
          more = result.claimed > 0 && result.published === result.claimed;
        }
      } catch (error) {
        this.logger.warn("Publishing round failed", { error: describe(error) });
      }
      if (!more) await this.pause();
    }
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.pollIntervalMs);
      this.abort.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
