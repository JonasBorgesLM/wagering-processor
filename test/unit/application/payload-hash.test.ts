import { describe, expect, test } from "bun:test";
import {
  canonicalPayload,
  type PayloadHashInput,
  payloadHash,
} from "../../../src/wagering/application/payload-hash";
import { WagerTransactionKind as Kind } from "../../../src/wagering/domain/wager-transaction";
import { brl, usd } from "../../support/domain-fixtures";

// The sample message from section 10 of the challenge.
const BET: PayloadHashInput = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  walletId: "0192f291-27dd-7d3f-8071-5f8685deef37",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: Kind.Bet,
  money: brl("25.00"),
};

describe("the algorithm is pinned (FR-51)", () => {
  // These vectors were computed with an independent tool (Python's json and hashlib), not with this code.
  // They are the stored format: if one changes, every stored hash disagrees with its own replay.
  test("the sample BET", () => {
    expect(canonicalPayload(BET)).toBe(
      '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","providerId":"provider-a","roundId":"round-987","walletId":"0192f291-27dd-7d3f-8071-5f8685deef37"}',
    );
    expect(payloadHash(BET)).toBe("629836932b79106b99523d06a1e7fa80689b0ea1e1c47aa3f0a5a2c87d0c4344");
  });

  test("a REFUND, whose reference joins the sorted keys", () => {
    const refund = {
      ...BET,
      externalTransactionId: "transaction-124",
      kind: Kind.Refund,
      referenceExternalTransactionId: "transaction-123",
    };
    expect(payloadHash(refund)).toBe("d47ad676d378f74510e611ad37b85a3c29e7bbbb3b987f6bfd65d67d28f68434");
  });

  test("non-ASCII text is hashed as UTF-8, not escaped", () => {
    expect(payloadHash({ ...BET, gameId: "fortuna-macaco-é-日本" })).toBe(
      "6c69d07f9cb083c14bf6e8d708d90a883b16c429bfc2c9d0a7948891ccfc1501",
    );
  });

  test("is 64 lowercase hex characters", () => {
    expect(payloadHash(BET)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("what does not change the hash", () => {
  // The issue's done criterion: HTTP and SQS forms of one operation hash equally.
  test("transport fields are ignored even when they are present on the object", () => {
    const http = { ...BET, idempotencyKey: "provider-a:transaction-123" };
    const sqs = {
      ...BET,
      idempotencyKey: "provider-a:transaction-123",
      messageId: "msg-123",
      occurredAt: "2026-07-29T15:00:00.000Z",
      type: "WagerTransactionRequested",
    };
    const other = {
      ...BET,
      idempotencyKey: "a-different-key",
      messageId: "msg-999",
      occurredAt: "2030-01-01T00:00:00.000Z",
    };
    expect(payloadHash(http)).toBe(payloadHash(BET));
    expect(payloadHash(sqs)).toBe(payloadHash(BET));
    expect(payloadHash(other)).toBe(payloadHash(BET));
  });

  test("the order the fields were written in", () => {
    const reversed: PayloadHashInput = {
      money: BET.money,
      kind: BET.kind,
      gameId: BET.gameId,
      roundId: BET.roundId,
      walletId: BET.walletId,
      playerId: BET.playerId,
      externalTransactionId: BET.externalTransactionId,
      providerId: BET.providerId,
    };
    expect(payloadHash(reversed)).toBe(payloadHash(BET));
    expect(canonicalPayload(reversed)).toBe(canonicalPayload(BET));
  });

  test("a reference that is absent, undefined or unset is the same operation", () => {
    expect(payloadHash({ ...BET, referenceExternalTransactionId: undefined })).toBe(payloadHash(BET));
  });

  test("how the same money was written, since only one spelling is valid", () => {
    expect(payloadHash({ ...BET, money: brl("25.00") })).toBe(payloadHash(BET));
  });
});

describe("what changes the hash", () => {
  // A changed field is a different operation under the same key: that must read as a conflict (FR-53).
  const changes: Array<[string, Partial<PayloadHashInput>]> = [
    ["providerId", { providerId: "provider-b" }],
    ["externalTransactionId", { externalTransactionId: "transaction-124" }],
    ["playerId", { playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2" }],
    ["walletId", { walletId: "0192f291-27dd-7d3f-8071-5f8685deef38" }],
    ["roundId", { roundId: "round-988" }],
    ["gameId", { gameId: "fortune-monkey" }],
    ["kind", { kind: Kind.Win }],
    ["the amount", { money: brl("25.01") }],
    ["the currency", { money: usd("25.00") }],
    ["a reference being added", { referenceExternalTransactionId: "transaction-100" }],
  ];
  test.each(changes)("%s", (_field, change) => {
    expect(payloadHash({ ...BET, ...change })).not.toBe(payloadHash(BET));
  });

  test("a different reference gives a different hash", () => {
    const one = payloadHash({ ...BET, kind: Kind.Refund, referenceExternalTransactionId: "a" });
    const two = payloadHash({ ...BET, kind: Kind.Refund, referenceExternalTransactionId: "b" });
    expect(one).not.toBe(two);
  });

  test("an empty reference is not an absent one", () => {
    expect(payloadHash({ ...BET, referenceExternalTransactionId: "" })).not.toBe(payloadHash(BET));
  });

  // Fields are named in the JSON, so moving text across a field boundary cannot collide.
  test("moving characters between two fields does not collide", () => {
    const a = payloadHash({ ...BET, providerId: "ab", externalTransactionId: "c" });
    const b = payloadHash({ ...BET, providerId: "a", externalTransactionId: "bc" });
    expect(a).not.toBe(b);
  });

  test("a value that looks like JSON cannot forge another field", () => {
    const forged = payloadHash({ ...BET, gameId: 'x","kind":"WIN' });
    expect(forged).not.toBe(payloadHash({ ...BET, gameId: "x", kind: Kind.Win }));
    expect(canonicalPayload({ ...BET, gameId: 'x","kind":"WIN' })).toContain('\\"kind\\":\\"WIN');
  });

  test("ids are opaque: composed and decomposed forms of the same letter differ", () => {
    const composed = payloadHash({ ...BET, gameId: "café" });
    const decomposed = payloadHash({ ...BET, gameId: "café" });
    expect(composed).not.toBe(decomposed);
  });
});

describe("fail closed on anything that is not a string", () => {
  // Types vanish at runtime, and a JSON body can carry anything. Hashing "5" would hide a missing validation.
  test.each([
    ["a number", 5],
    ["null", null],
    ["a bigint", 5n],
    ["a boolean", true],
    ["an array", ["a"]],
  ])("a field holding %s is refused rather than hashed", (_name, value) => {
    // The message is pinned: null would also raise a TypeError from Object.getPrototypeOf, for the wrong reason.
    expect(() => payloadHash({ ...BET, providerId: value as unknown as string })).toThrow(
      /cannot canonicalize/,
    );
  });

  // `typeof` says "object" for all of these, and Object.entries of a Date is empty: without a prototype check
  // they would be hashed as {} and two different values would collide.
  test.each([
    ["a Date", new Date()],
    ["a Map", new Map([["a", "b"]])],
    [
      "a class instance",
      new (class Probe {
        id = "x";
      })(),
    ],
    ["an object with no prototype", Object.create(null)],
  ])("%s is refused rather than hashed as {}", (_name, value) => {
    expect(() => payloadHash({ ...BET, gameId: value as unknown as string })).toThrow(TypeError);
  });

  test("a money-shaped object that is not Money is refused too", () => {
    const fake = { toJSON: () => ({ amount: 25, currency: "BRL" }) };
    expect(() => payloadHash({ ...BET, money: fake as unknown as PayloadHashInput["money"] })).toThrow(
      TypeError,
    );
  });

  test("the amount reaches the hash as the two-decimal string", () => {
    expect(canonicalPayload(BET)).toContain('"amount":"25.00"');
  });
});
