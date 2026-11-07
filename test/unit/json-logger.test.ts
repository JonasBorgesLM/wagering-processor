import { describe, expect, test } from "bun:test";
import { JsonLogger } from "../../src/platform/logging/json-logger";

function capture() {
  const lines: Record<string, unknown>[] = [];
  return { lines, logger: new JsonLogger((line) => lines.push(JSON.parse(line))) };
}

describe("JsonLogger", () => {
  test("emits correlation fields as structured JSON", () => {
    const { lines, logger } = capture();
    logger.log("Settled", {
      correlationId: "c1",
      messageId: "m1",
      transactionId: "t1",
      walletId: "w1",
      providerId: "p1",
    });
    expect(lines[0]).toMatchObject({
      level: "info",
      message: "Settled",
      correlationId: "c1",
      messageId: "m1",
      transactionId: "t1",
      walletId: "w1",
      providerId: "p1",
    });
  });

  test("SR-01: drops fields outside the allowlist", () => {
    const { lines, logger } = capture();
    logger.log("Settled", {
      walletId: "w1",
      balance: { amount: "975.00", currency: "BRL" },
      payload: { playerId: "secret-player" },
    });
    expect(lines[0]?.walletId).toBe("w1");
    expect(Object.keys(lines[0] ?? {}).sort()).toEqual(["level", "message", "time", "walletId"]);
  });

  test("keeps the Nest logger name as context", () => {
    const { lines, logger } = capture();
    logger.warn("Slow", "Consumer");
    expect(lines[0]).toMatchObject({ level: "warn", message: "Slow", context: "Consumer" });
  });
});
