import type { NestExpressApplication } from "@nestjs/platform-express";
import { createApp } from "../../src/app";
import { loadConfig } from "../../src/platform/config/config";
import { JsonLogger } from "../../src/platform/logging/json-logger";
import { TEST_ENV } from "./env";
import { provisionQueues } from "./queues";

export interface RunningApp {
  instance: NestExpressApplication;
  url: string;
  /** Every log line the application wrote, parsed. */
  logs: Array<Record<string, unknown>>;
  stop(): Promise<void>;
}

/**
 * The whole application as main builds it, listening on a free port. `env` overrides the configuration for this
 * one instance, which is how a test makes the lock or the pool small enough to exhaust.
 */
export async function startApp(
  databaseUrl: string,
  options: { roles?: string; env?: Record<string, string> } = {},
): Promise<RunningApp> {
  // The application's SQS client uses the standard AWS credential chain, as it must in production. Built in this
  // process it finds them only if the environment has them: on a developer machine Bun loads them from .env, and
  // in CI nothing does, so readiness waited on credentials until its own 2 s timeout and answered 503.
  process.env.AWS_ACCESS_KEY_ID ??= TEST_ENV.AWS_ACCESS_KEY_ID;
  process.env.AWS_SECRET_ACCESS_KEY ??= TEST_ENV.AWS_SECRET_ACCESS_KEY;
  // Readiness probes the queue, so it has to exist whatever ran before this file.
  await provisionQueues();

  const logs: Array<Record<string, unknown>> = [];
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    AWS_REGION: TEST_ENV.AWS_REGION,
    SQS_ENDPOINT: TEST_ENV.SQS_ENDPOINT,
    PORT: "3000",
    APP_ROLES: options.roles ?? "api",
    ...options.env,
  });
  const instance = await createApp(config, new JsonLogger((line) => logs.push(JSON.parse(line))));
  await instance.listen(0);
  const url = (await instance.getUrl()).replace("[::1]", "localhost");
  return { instance, url, logs, stop: () => instance.close() };
}
