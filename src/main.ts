import "reflect-metadata";
import { createApp } from "./app";
import { loadConfig } from "./platform/config/config";
import { JsonLogger } from "./platform/logging/json-logger";

const logger = new JsonLogger();

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config, logger);

  // If a hook hangs, leave rather than block: unacked messages return to the queue on their own.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      setTimeout(() => {
        logger.error("Shutdown deadline exceeded", "Bootstrap");
        process.exit(1);
      }, config.shutdownTimeoutMs).unref();
    });
  }

  await app.listen(config.port);
  logger.log(`Listening on ${config.port} with roles ${[...config.roles].join(",")}`, "Bootstrap");
}

bootstrap().catch((error: unknown) => {
  logger.fatal("Startup failed", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
