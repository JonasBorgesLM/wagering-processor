import { describe, expect, test } from "bun:test";
import { InvalidRequestError } from "../../../src/wagering/application/errors";
import { payloadHash } from "../../../src/wagering/application/payload-hash";
import { parseSubmitTransaction } from "../../../src/wagering/infrastructure/http/validation";
import {
  parseWagerMessage,
  UnprocessableMessageError,
} from "../../../src/wagering/infrastructure/messaging/wager-message";

const valid = () => ({
  messageId: "msg-123",
  type: "WagerTransactionRequested",
  occurredAt: "2026-07-29T15:00:00.000Z",
  data: {
    providerId: "provider-a",
    externalTransactionId: "transaction-123",
    idempotencyKey: "provider-a:transaction-123",
    playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
    roundId: "round-987",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
  },
});
const parse = (message: unknown) => parseWagerMessage(JSON.stringify(message));
const issuesOf = (message: unknown): string[] => {
  try {
    parse(message);
  } catch (error) {
    if (error instanceof InvalidRequestError)
      return error.issues.map((issue) => `${issue.field}: ${issue.reason}`);
    throw error;
  }
  return [];
};

describe("the example message of section 10 (SR-02)", () => {
  test("becomes a command carrying the message id as correlation and cause", () => {
    const { messageId, command } = parse(valid());
    expect(messageId).toBe("msg-123");
    expect(command).toMatchObject({
      idempotencyKey: "provider-a:transaction-123",
      providerId: "provider-a",
      kind: "BET",
      correlationId: "msg-123",
      causationId: "msg-123",
    });
    expect(command.money.toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
  });

  test("hashes the same as the same operation over HTTP, or a replay by the other channel would be a conflict (FR-51)", () => {
    const { data } = valid();
    const { idempotencyKey, ...body } = data;
    const http = parseSubmitTransaction({ "idempotency-key": idempotencyKey }, body);
    expect(payloadHash(parse(valid()).command)).toBe(payloadHash(http));
  });

  test("accepts a reference on a reversal", () => {
    const message = valid();
    Object.assign(message.data, { kind: "REFUND", referenceExternalTransactionId: "transaction-1" });
    expect(parse(message).command.referenceExternalTransactionId).toBe("transaction-1");
  });
});

describe("a message that can never be processed", () => {
  test.each([
    ["not JSON", "{oops"],
    ["empty", ""],
  ])("%s is unprocessable", (_name, body) => {
    expect(() => parseWagerMessage(body)).toThrow(UnprocessableMessageError);
  });

  test("a missing body is unprocessable", () => {
    expect(() => parseWagerMessage(undefined)).toThrow(UnprocessableMessageError);
  });

  test("an unknown type is unprocessable, whatever else it holds", () => {
    expect(() => parse({ ...valid(), type: "SomethingElse" })).toThrow(UnprocessableMessageError);
    expect(() => parse({ type: "SomethingElse" })).toThrow(UnprocessableMessageError);
  });
});

describe("an invalid message is told what to fix, field by field", () => {
  test.each([
    ["a body that is not an object", [1, 2], ["body: must be a JSON object"]],
    ["null", null, ["body: must be a JSON object"]],
  ])("%s", (_name, message, expected) => {
    expect(issuesOf(message)).toEqual(expected);
  });

  test("every missing envelope field", () => {
    expect(issuesOf({ type: "WagerTransactionRequested" }).sort()).toEqual([
      "data: is required",
      "messageId: is required",
      "occurredAt: is required",
    ]);
  });

  test("an unknown envelope or data field is refused, not ignored (INT-25)", () => {
    const message = valid();
    Object.assign(message, { extra: 1 });
    Object.assign(message.data, { surprise: true });
    expect(issuesOf(message).sort()).toEqual([
      "data.surprise: is not a known field",
      "extra: is not a known field",
    ]);
  });

  test("issues name the field as the provider sent it, under data", () => {
    const message = valid();
    message.data.money = { amount: "25.5", currency: "BRL" };
    message.data.walletId = "nope";
    const issues = issuesOf(message);
    expect(issues).toContain("data.walletId: must be a UUID");
    expect(issues.some((issue) => issue.startsWith("data.money:"))).toBe(true);
  });

  test("OPENING is internal (FR-11)", () => {
    const message = valid();
    message.data.kind = "OPENING";
    expect(issuesOf(message)).toEqual(["data.kind: OPENING is internal and cannot be submitted"]);
  });

  test("the key and the message id are bounded and free of control characters (SR-04)", () => {
    const message = valid();
    message.messageId = "a".repeat(256);
    message.data.idempotencyKey = "bad\u0000key";
    expect(issuesOf(message).sort()).toEqual([
      "data.idempotencyKey: must not contain control characters",
      "messageId: must be at most 255 characters",
    ]);
  });

  test("occurredAt must be a date", () => {
    expect(issuesOf({ ...valid(), occurredAt: "yesterday" })).toEqual(["occurredAt: must be a date"]);
    expect(issuesOf({ ...valid(), occurredAt: 1722265200000 })).toEqual(["occurredAt: must be a date"]);
  });

  test("a reversal without its reference, and a BET with one (FR-21)", () => {
    const refund = valid();
    refund.data.kind = "REFUND";
    expect(issuesOf(refund)).toEqual(["data.referenceExternalTransactionId: is required for a REFUND"]);
    const bet = valid();
    Object.assign(bet.data, { referenceExternalTransactionId: "x" });
    expect(issuesOf(bet)).toEqual(["data.referenceExternalTransactionId: is not allowed for a BET"]);
  });
});
