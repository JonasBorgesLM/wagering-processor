import { describe, expect, test } from "bun:test";
import {
  ExternalIdConflictError,
  IdempotencyConflictError,
  InvalidRequestError,
  MessageIdConflictError,
  TransientFailureError,
  WalletNotFoundError,
} from "../../../src/wagering/application/errors";
import { UnprocessableMessageError } from "../../../src/wagering/infrastructure/messaging/wager-message";
import { describeForLog } from "../../../src/wagering/infrastructure/messaging/wager-queue-consumer";

// Requirements: SR-01. What the consumer's log may say about a failed message: the code of an application error,
// never its message, which names what the sender sent.

describe("a failure as a log line may say it (SR-01)", () => {
  test.each([
    [
      new IdempotencyConflictError("key provider-a:secret-key was used with a different payload"),
      "IDEMPOTENCY_CONFLICT",
    ],
    [
      new ExternalIdConflictError("provider-a:secret-external already exists under another key"),
      "EXTERNAL_ID_CONFLICT",
    ],
    [
      new MessageIdConflictError("message secret-message was seen before with different content"),
      "MESSAGE_ID_CONFLICT",
    ],
    [new WalletNotFoundError("wallet secret-wallet does not exist"), "WALLET_NOT_FOUND"],
    [
      new InvalidRequestError([{ field: "data.secret-field", reason: "is not a known field" }]),
      "VALIDATION_ERROR",
    ],
  ])("%s is logged as its code only", (error, code) => {
    const line = describeForLog(error);
    expect(line).toContain(code);
    expect(line).not.toContain("secret");
  });

  test("the system's own failures are described in full, because diagnosing them needs it", () => {
    expect(describeForLog(new TransientFailureError("transient database failure (55P03)"))).toBe(
      "TransientFailureError: transient database failure (55P03)",
    );
    expect(describeForLog(new UnprocessableMessageError("the message body is not JSON"))).toBe(
      "UnprocessableMessageError: the message body is not JSON",
    );
    expect(describeForLog(new TypeError("a bug"))).toBe("TypeError: a bug");
    expect(describeForLog("not an Error")).toBe("not an Error");
  });
});
