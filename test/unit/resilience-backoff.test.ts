import { describe, expect, test } from "bun:test";
import { backoffSeconds } from "../../src/platform/resilience/backoff";

const policy = { baseSeconds: 2, capSeconds: 30 };

describe("the delay before a failed message is delivered again (NFR-11)", () => {
  test("the ceiling doubles with each delivery and stops at the cap", () => {
    const ceilings = [1, 2, 3, 4, 5, 6, 10].map((receives) => backoffSeconds(receives, policy, () => 1));
    expect(ceilings).toEqual([2, 4, 8, 16, 30, 30, 30]);
  });

  test("the delay is drawn from the upper half of the ceiling, so it is never immediate", () => {
    expect(backoffSeconds(3, policy, () => 0)).toBe(4);
    expect(backoffSeconds(3, policy, () => 1)).toBe(8);
    expect(backoffSeconds(3, policy, () => 0.5)).toBe(6);
  });

  test("it is spread: messages that failed together do not all come back together", () => {
    const delays = new Set(
      Array.from({ length: 200 }, () => backoffSeconds(4, { baseSeconds: 4, capSeconds: 60 })),
    );
    expect(delays.size).toBeGreaterThan(5);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(16);
      expect(delay).toBeLessThanOrEqual(32);
    }
  });

  test("a whole number of seconds, never below one", () => {
    expect(backoffSeconds(1, { baseSeconds: 1, capSeconds: 1 }, () => 0)).toBe(1);
    expect(Number.isInteger(backoffSeconds(2, { baseSeconds: 3, capSeconds: 100 }, () => 0.37))).toBe(true);
  });

  test("a count of zero or less is treated as the first delivery", () => {
    expect(backoffSeconds(0, policy, () => 1)).toBe(2);
    expect(backoffSeconds(-3, policy, () => 1)).toBe(2);
  });
});
