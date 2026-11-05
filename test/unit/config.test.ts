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

  test.each(["0", "-1", "1.5", "abc", "1e3"])("rejects PORT=%s", (port) => {
    expect(() => loadConfig({ ...valid, PORT: port })).toThrow(InvalidConfigError);
  });
});
