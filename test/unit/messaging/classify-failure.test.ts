import { describe, expect, test } from "bun:test";
import {
  ExternalIdConflictError,
  IdempotencyConflictError,
  InvalidRequestError,
  MessageIdConflictError,
  TransientFailureError,
  WalletNotFoundError,
} from "../../../src/wagering/application/errors";
import { classifyFailure } from "../../../src/wagering/infrastructure/messaging/classify-failure";
import { UnprocessableMessageError } from "../../../src/wagering/infrastructure/messaging/wager-message";

describe("what a failed message becomes (section 3.11)", () => {
  test("a transient failure is retried", () => {
    expect(classifyFailure(new TransientFailureError("lock"))).toBe("retry");
  });

  test.each([
    ["malformed or unknown message", new UnprocessableMessageError("x")],
    ["invalid payload", new InvalidRequestError([{ field: "a", reason: "b" }])],
    ["idempotency conflict", new IdempotencyConflictError("x")],
    ["external id conflict", new ExternalIdConflictError("x")],
    ["message id conflict (INT-17)", new MessageIdConflictError("x")],
    ["wallet not found", new WalletNotFoundError("x")],
  ])("%s goes to the dead-letter queue", (_name, error) => {
    expect(classifyFailure(error)).toBe("dead-letter");
  });

  test("a failure nobody foresaw is retried, so a fix finds its messages still in the queue", () => {
    expect(classifyFailure(new TypeError("a bug"))).toBe("retry");
    expect(classifyFailure("not even an Error")).toBe("retry");
  });
});
