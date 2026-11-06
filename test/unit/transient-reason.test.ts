import { describe, expect, test } from "bun:test";
import {
  POOL_TIMEOUT_MESSAGE,
  transientReason,
} from "../../src/wagering/infrastructure/persistence/mikro-orm-unit-of-work";

describe("why a database call was transient, as a label (NFR-06)", () => {
  test.each([
    [{ sqlState: "55P03" }, "lock_timeout"],
    [{ code: "55P03" }, "lock_timeout"],
    [{ sqlState: "40P01" }, "deadlock"],
    [{ sqlState: "40001" }, "serialization_failure"],
    [{ sqlState: "57014" }, "statement_timeout"],
    [{ message: POOL_TIMEOUT_MESSAGE }, "pool_timeout"],
    [{ code: "ECONNREFUSED" }, "connection"],
    [{ sqlState: "08006" }, "connection"],
    [{ sqlState: "57P01" }, "connection"],
    [{ sqlState: "53300" }, "other"],
    [new Error("something else"), "other"],
    [undefined, "other"],
  ])("%j is %s", (error, reason) => {
    expect<string>(transientReason(error)).toBe(reason as string);
  });
});
