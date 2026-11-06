import { type BeforeApplicationShutdown, Logger, type OnApplicationBootstrap } from "@nestjs/common";

/**
 * Runs `round` for as long as the process lives, sleeping `pollIntervalMs` when a round says there is nothing more
 * to do. A round that throws is logged and the loop goes on: a database that is away for a minute is not a reason
 * for a worker to die (NFR-11).
 *
 * Stopping waits for the round in progress, which is bounded by the timeouts inside it, so what a round claimed is
 * finished or put back and not left to its lease (FR-81). It begins the drain first, for the reason given on
 * `DrainState`.
 */
export class PollingWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger: Logger;
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;

  constructor(
    name: string,
    /** Returns whether to go again at once, as when a full batch suggests a backlog. */
    private readonly round: () => Promise<boolean>,
    private readonly pollIntervalMs: number,
    private readonly drain: { begin(signal?: string): void } = { begin: () => undefined },
  ) {
    this.logger = new Logger(name);
  }

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
        more = await this.round();
      } catch (error) {
        this.logger.warn("Round failed", {
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
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
