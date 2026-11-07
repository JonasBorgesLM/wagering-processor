import { describe, expect, test } from "bun:test";
import { InvalidConfigError, loadConfig } from "../../src/platform/config/config";

const valid = {
  DATABASE_URL: "postgres://localhost/db",
  AWS_REGION: "us-east-1",
  SQS_ENDPOINT: "http://localhost:4566",
};

describe("loadConfig", () => {
  test("defaults to every role, so a single instance is a complete system", () => {
    expect([...loadConfig(valid).roles]).toEqual(["api", "consumer", "publisher", "reference-worker"]);
  });

  test("runs only the requested roles", () => {
    expect([...loadConfig({ ...valid, APP_ROLES: "publisher, consumer" }).roles]).toEqual([
      "publisher",
      "consumer",
    ]);
  });

  test("rejects an unknown role instead of silently running less than asked", () => {
    expect(() => loadConfig({ ...valid, APP_ROLES: "api,publsher" })).toThrow(InvalidConfigError);
  });

  test.each(["DATABASE_URL", "AWS_REGION", "SQS_ENDPOINT"])("requires %s", (name) => {
    expect(() => loadConfig({ ...valid, [name]: undefined })).toThrow(`${name} is required`);
  });

  test("has lock and statement limits by default, and takes them from the environment", () => {
    expect(loadConfig(valid)).toMatchObject({ lockTimeoutMs: 2_000, statementTimeoutMs: 5_000 });
    expect(loadConfig({ ...valid, LOCK_TIMEOUT_MS: "150", STATEMENT_TIMEOUT_MS: "900" })).toMatchObject({
      lockTimeoutMs: 150,
      statementTimeoutMs: 900,
    });
    expect(() => loadConfig({ ...valid, LOCK_TIMEOUT_MS: "0" })).toThrow(InvalidConfigError);
    expect(() => loadConfig({ ...valid, STATEMENT_TIMEOUT_MS: "soon" })).toThrow(InvalidConfigError);
  });

  test("has pool limits by default, and takes them from the environment", () => {
    expect(loadConfig(valid)).toMatchObject({ databasePoolMax: 10, databaseAcquireTimeoutMs: 1_000 });
    expect(
      loadConfig({ ...valid, DATABASE_POOL_MAX: "4", DATABASE_ACQUIRE_TIMEOUT_MS: "250" }),
    ).toMatchObject({
      databasePoolMax: 4,
      databaseAcquireTimeoutMs: 250,
    });
    expect(() => loadConfig({ ...valid, DATABASE_POOL_MAX: "0" })).toThrow(InvalidConfigError);
    expect(() => loadConfig({ ...valid, DATABASE_ACQUIRE_TIMEOUT_MS: "-1" })).toThrow(InvalidConfigError);
  });

  test("a poll waits 5 seconds by default, and never more than the 20 SQS allows", () => {
    expect(loadConfig(valid).queueWaitSeconds).toBe(5);
    expect(loadConfig({ ...valid, QUEUE_WAIT_SECONDS: "20" }).queueWaitSeconds).toBe(20);
    expect(() => loadConfig({ ...valid, QUEUE_WAIT_SECONDS: "21" })).toThrow(InvalidConfigError);
    expect(() => loadConfig({ ...valid, QUEUE_WAIT_SECONDS: "0" })).toThrow(InvalidConfigError);
  });

  test("the outbox claims 100 rows a round and sends over one lane, up to 32", () => {
    expect(loadConfig(valid)).toMatchObject({ outboxBatchSize: 100, outboxPublishConcurrency: 1 });
    expect(loadConfig({ ...valid, OUTBOX_PUBLISH_CONCURRENCY: "32" }).outboxPublishConcurrency).toBe(32);
    expect(() => loadConfig({ ...valid, OUTBOX_PUBLISH_CONCURRENCY: "33" })).toThrow(InvalidConfigError);
    expect(() => loadConfig({ ...valid, OUTBOX_PUBLISH_CONCURRENCY: "0" })).toThrow(InvalidConfigError);
  });

  test("the retry backoff starts at 2 s and is capped at 30 s, and takes both from the environment", () => {
    expect(loadConfig(valid)).toMatchObject({ queueBackoffBaseSeconds: 2, queueBackoffCapSeconds: 30 });
    expect(
      loadConfig({ ...valid, QUEUE_BACKOFF_BASE_SECONDS: "1", QUEUE_BACKOFF_CAP_SECONDS: "600" }),
    ).toMatchObject({ queueBackoffBaseSeconds: 1, queueBackoffCapSeconds: 600 });
    expect(() => loadConfig({ ...valid, QUEUE_BACKOFF_CAP_SECONDS: "43201" })).toThrow(InvalidConfigError);
    expect(() => loadConfig({ ...valid, QUEUE_BACKOFF_BASE_SECONDS: "0" })).toThrow(InvalidConfigError);
  });

  test.each(["0", "-1", "1.5", "abc", "1e3"])("rejects PORT=%s", (port) => {
    expect(() => loadConfig({ ...valid, PORT: port })).toThrow(InvalidConfigError);
  });
});
