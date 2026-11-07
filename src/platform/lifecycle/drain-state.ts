import { type BeforeApplicationShutdown, Global, Injectable, Logger, Module } from "@nestjs/common";

/**
 * Whether this process has been asked to stop. Readiness reads it, so a load balancer stops routing here while
 * in-flight work finishes (FR-80).
 *
 * Whoever is about to wait for in-flight work calls `begin` first. Nest runs the shutdown hooks of different
 * modules one after another, so a hook that waits would otherwise delay this one, and readiness would keep
 * answering "ready" for as long as the work took: the opposite of what it is for. `begin` is idempotent.
 */
@Injectable()
export class DrainState implements BeforeApplicationShutdown {
  draining = false;
  private readonly logger = new Logger(DrainState.name);

  begin(signal?: string): void {
    if (this.draining) return;
    this.draining = true;
    this.logger.log(`Draining after ${signal ?? "shutdown request"}`);
  }

  beforeApplicationShutdown(signal?: string): void {
    this.begin(signal);
  }
}

@Global()
@Module({ providers: [DrainState], exports: [DrainState] })
export class LifecycleModule {}
