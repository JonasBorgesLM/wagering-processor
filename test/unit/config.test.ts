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

  test.each(["0", "-1", "1.5", "abc", "1e3"])("rejects PORT=%s", (port) => {
    expect(() => loadConfig({ ...valid, PORT: port })).toThrow(InvalidConfigError);
  });
});
