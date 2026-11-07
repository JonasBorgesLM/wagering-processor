import { describe, expect, test } from "bun:test";
import { InvalidRequestError, type RequestIssue } from "../../../src/wagering/application/errors";
import { DomainError } from "../../../src/wagering/domain/errors";
import { Money } from "../../../src/wagering/domain/money";
import {
  WagerTransactionKind as Kind,
  WagerTransaction,
} from "../../../src/wagering/domain/wager-transaction";
import {
  parseProviderTransactionPath,
  parseSubmitTransaction,
  parseTransactionId,
} from "../../../src/wagering/infrastructure/http/validation";

const PLAYER = "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1";
const WALLET = "0192f291-27dd-7d3f-8071-5f8685deef37";
const KEY = "provider-a:transaction-123";

const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: PLAYER,
  walletId: WALLET,
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: "BET",
  money: { amount: "25.00", currency: "BRL" },
  ...overrides,
});
const without = (key: string) => {
  const { [key]: _removed, ...rest } = body();
  return rest;
};
// No default value on purpose: a default would swallow an explicit undefined and send the key the test means to omit.
const headers = (key: string | string[]) => ({ "idempotency-key": key });
const noKey = {} as Record<string, string | string[] | undefined>;
const ok = headers(KEY);

function issuesOf(attempt: () => unknown): RequestIssue[] {
  try {
    attempt();
  } catch (error) {
    if (error instanceof InvalidRequestError) return [...error.issues];
    throw error;
  }
  throw new Error("expected the request to be refused");
}
const fields = (attempt: () => unknown) =>
  issuesOf(attempt)
    .map((issue) => issue.field)
    .sort();

describe("a valid submission", () => {
  test("is accepted exactly as the challenge's example", () => {
    const request = parseSubmitTransaction(ok, body());
    expect(request).toMatchObject({
      idempotencyKey: KEY,
      providerId: "provider-a",
      externalTransactionId: "transaction-123",
      playerId: PLAYER,
      walletId: WALLET,
      roundId: "round-987",
      gameId: "fortune-chimp",
      kind: "BET",
      referenceExternalTransactionId: undefined,
    });
    expect(request.money.toString()).toBe("25.00 BRL");
  });

  test.each(["BET", "WIN", "LOSS"])("%s needs no reference", (kind) => {
    expect(
      parseSubmitTransaction(
        ok,
        body({ kind, money: { amount: kind === "LOSS" ? "0.00" : "5.00", currency: "BRL" } }),
      ).kind,
    ).toBe(kind as Kind);
  });

  test.each(["REFUND", "ROLLBACK"])("%s carries its reference", (kind) => {
    const request = parseSubmitTransaction(
      ok,
      body({ kind, referenceExternalTransactionId: "transaction-100" }),
    );
    expect(request.referenceExternalTransactionId).toBe("transaction-100");
  });

  test("a WIN or LOSS may carry one", () => {
    expect(
      parseSubmitTransaction(ok, body({ kind: "WIN", referenceExternalTransactionId: "t0" }))
        .referenceExternalTransactionId,
    ).toBe("t0");
  });

  test("a LOSS of zero is valid, and a LOSS of something too", () => {
    expect(
      parseSubmitTransaction(
        ok,
        body({ kind: "LOSS", money: { amount: "0.00", currency: "BRL" } }),
      ).money.isZero(),
    ).toBe(true);
    expect(
      parseSubmitTransaction(
        ok,
        body({ kind: "LOSS", money: { amount: "9.99", currency: "BRL" } }),
      ).money.isPositive(),
    ).toBe(true);
  });

  test("player and wallet ids are normalized to lowercase", () => {
    const request = parseSubmitTransaction(
      ok,
      body({ playerId: PLAYER.toUpperCase(), walletId: WALLET.toUpperCase() }),
    );
    expect(request.playerId).toBe(PLAYER);
    expect(request.walletId).toBe(WALLET);
  });

  test("a provider's own ids are kept exactly: nothing trimmed, cased or normalized", () => {
    const request = parseSubmitTransaction(
      headers(" Key "),
      body({ externalTransactionId: " Tx-ÀB ", roundId: "R 1" }),
    );
    expect(request.idempotencyKey).toBe(" Key ");
    expect(request.externalTransactionId).toBe(" Tx-ÀB ");
    expect(request.roundId).toBe("R 1");
  });
});

describe("the Idempotency-Key header (FR-50)", () => {
  test("is required", () => {
    expect(issuesOf(() => parseSubmitTransaction(noKey, body()))).toEqual([
      { field: "Idempotency-Key", reason: "is required" },
    ]);
  });

  test.each([
    ["empty", ""],
    ["over 255 characters", "k".repeat(256)],
    ["with a newline", "a\nb"],
    ["with a NUL", "a\u0000b"],
    ["with a tab", "a\tb"],
  ])("%s is refused", (_name, key) => {
    expect(fields(() => parseSubmitTransaction(headers(key), body()))).toEqual(["Idempotency-Key"]);
  });

  test("255 characters is the most", () => {
    expect(parseSubmitTransaction(headers("k".repeat(255)), body()).idempotencyKey).toHaveLength(255);
  });

  test("a header given twice is refused", () => {
    expect(fields(() => parseSubmitTransaction(headers(["a", "b"]), body()))).toEqual(["Idempotency-Key"]);
  });

  // The header is the truth: a key inside the body is not read, and is an unknown field.
  test("a key in the body is an unknown field, not a second source", () => {
    expect(fields(() => parseSubmitTransaction(ok, body({ idempotencyKey: KEY })))).toEqual([
      "idempotencyKey",
    ]);
  });

  test("a missing header and a bad body are both reported at once", () => {
    expect(fields(() => parseSubmitTransaction(noKey, {}))).toContain("Idempotency-Key");
    expect(fields(() => parseSubmitTransaction(noKey, {}))).toContain("providerId");
  });
});

describe("the body", () => {
  test.each([undefined, null, "text", 7, true])("%p is not a JSON object", (value) => {
    expect(issuesOf(() => parseSubmitTransaction(ok, value))).toContainEqual({
      field: "body",
      reason: "must be a JSON object",
    });
  });

  // Kept out of the table above: Bun spreads an array element into the test's arguments.
  test("an array is not a JSON object either", () => {
    expect(issuesOf(() => parseSubmitTransaction(ok, [body()]))).toContainEqual({
      field: "body",
      reason: "must be a JSON object",
    });
  });

  test.each([
    "providerId",
    "externalTransactionId",
    "playerId",
    "walletId",
    "roundId",
    "gameId",
    "kind",
    "money",
  ])("%s is required", (key) => {
    expect(issuesOf(() => parseSubmitTransaction(ok, without(key)))).toEqual([
      { field: key, reason: "is required" },
    ]);
  });

  test("an unknown field is refused (INT-25)", () => {
    expect(issuesOf(() => parseSubmitTransaction(ok, body({ amount: "1.00" })))).toEqual([
      { field: "amount", reason: "is not a known field" },
    ]);
  });

  test.each(["providerId", "externalTransactionId", "roundId", "gameId"])(
    "%s must be a bounded string without control characters",
    (key) => {
      for (const bad of ["", 7, null, "x".repeat(256), "a\u0000b", "a\nb", "a\u007fb"]) {
        expect(fields(() => parseSubmitTransaction(ok, body({ [key]: bad })))).toEqual([key]);
      }
    },
  );

  test.each(["playerId", "walletId"])("%s must be a UUID", (key) => {
    for (const bad of ["nope", "", 7, null, `${PLAYER}0`]) {
      expect(fields(() => parseSubmitTransaction(ok, body({ [key]: bad })))).toEqual([key]);
    }
  });

  test('the provider id "internal" is reserved for the OPENING (FR-62)', () => {
    expect(issuesOf(() => parseSubmitTransaction(ok, body({ providerId: "internal" })))).toEqual([
      { field: "providerId", reason: '"internal" is reserved' },
    ]);
  });

  test("a kind sent as an array is refused too", () => {
    expect(fields(() => parseSubmitTransaction(ok, body({ kind: ["BET"] })))).toEqual(["kind"]);
  });

  test("OPENING cannot be submitted, and says why (§6.3)", () => {
    expect(issuesOf(() => parseSubmitTransaction(ok, body({ kind: "OPENING" })))).toEqual([
      { field: "kind", reason: "OPENING is internal and cannot be submitted" },
    ]);
  });

  test.each(["bet", "Win", "TIP", "", 7, null])("kind %p is refused, naming what is accepted", (kind) => {
    const [issue] = issuesOf(() => parseSubmitTransaction(ok, body({ kind })));
    expect(issue?.field).toBe("kind");
    expect(issue?.reason).toContain("BET, WIN, LOSS, REFUND, ROLLBACK");
  });

  test.each(["25", "25.5", "-1.00", "1e3", 25, null, "NaN"])(
    "an amount of %p is refused (FR-01)",
    (amount) => {
      expect(fields(() => parseSubmitTransaction(ok, body({ money: { amount, currency: "BRL" } })))).toEqual([
        "money",
      ]);
    },
  );

  test.each(["BET", "WIN", "REFUND", "ROLLBACK"])("a zero %s is refused: only a LOSS may be zero", (kind) => {
    const extra = kind === "REFUND" || kind === "ROLLBACK" ? { referenceExternalTransactionId: "t0" } : {};
    expect(
      issuesOf(() =>
        parseSubmitTransaction(ok, body({ kind, money: { amount: "0.00", currency: "BRL" }, ...extra })),
      ),
    ).toEqual([{ field: "money", reason: `must be greater than zero for a ${kind}` }]);
  });
});

describe("the reference (§7)", () => {
  test.each(["REFUND", "ROLLBACK"])("a %s without one is refused", (kind) => {
    expect(issuesOf(() => parseSubmitTransaction(ok, body({ kind })))).toEqual([
      { field: "referenceExternalTransactionId", reason: `is required for a ${kind}` },
    ]);
  });

  test("a BET with one is refused", () => {
    expect(
      issuesOf(() => parseSubmitTransaction(ok, body({ referenceExternalTransactionId: "t0" }))),
    ).toEqual([{ field: "referenceExternalTransactionId", reason: "is not allowed for a BET" }]);
  });

  test("a transaction cannot reference itself", () => {
    expect(
      issuesOf(() =>
        parseSubmitTransaction(
          ok,
          body({ kind: "REFUND", referenceExternalTransactionId: "transaction-123" }),
        ),
      ),
    ).toEqual([{ field: "referenceExternalTransactionId", reason: "cannot be the transaction itself" }]);
  });

  test.each(["", 7, "x".repeat(256), "a\u0000"])("a reference of %p is refused", (reference) => {
    expect(
      fields(() =>
        parseSubmitTransaction(ok, body({ kind: "REFUND", referenceExternalTransactionId: reference })),
      ),
    ).toContain("referenceExternalTransactionId");
  });

  test("every problem is reported at once", () => {
    const found = fields(() =>
      parseSubmitTransaction(noKey, {
        providerId: "internal",
        kind: "OPENING",
        money: { amount: "1", currency: "x" },
        extra: 1,
      }),
    );
    expect(found).toEqual([
      "Idempotency-Key",
      "externalTransactionId",
      "extra",
      "gameId",
      "kind",
      "money",
      "playerId",
      "providerId",
      "roundId",
      "walletId",
    ]);
  });
});

// The edge repeats rules the domain also holds, so the provider is told which field to fix. If the two ever disagree,
// one is wrong: a request the edge lets through that the domain refuses is a 400 without a field, and one the edge
// refuses that the domain would accept is a rule that exists in one place only.
describe("the edge and the domain agree", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["a plain BET", {}],
    ["a zero BET", { money: { amount: "0.00", currency: "BRL" } }],
    ["a zero WIN", { kind: "WIN", money: { amount: "0.00", currency: "BRL" } }],
    ["a zero LOSS", { kind: "LOSS", money: { amount: "0.00", currency: "BRL" } }],
    [
      "a zero REFUND",
      { kind: "REFUND", referenceExternalTransactionId: "t0", money: { amount: "0.00", currency: "BRL" } },
    ],
    ["a BET with a reference", { referenceExternalTransactionId: "t0" }],
    ["a REFUND without a reference", { kind: "REFUND" }],
    ["a ROLLBACK without a reference", { kind: "ROLLBACK" }],
    ["a REFUND with one", { kind: "REFUND", referenceExternalTransactionId: "t0" }],
    ["a ROLLBACK with one", { kind: "ROLLBACK", referenceExternalTransactionId: "t0" }],
    ["a WIN with one", { kind: "WIN", referenceExternalTransactionId: "t0" }],
    [
      "a LOSS with one",
      { kind: "LOSS", referenceExternalTransactionId: "t0", money: { amount: "0.00", currency: "BRL" } },
    ],
    ["a self reference", { kind: "REFUND", referenceExternalTransactionId: "transaction-123" }],
    ["the reserved provider", { providerId: "internal" }],
    ["an OPENING", { kind: "OPENING" }],
  ];

  test.each(cases)("%s", (_name, overrides) => {
    const input = body(overrides);
    const edgeAccepts = accepts(() => parseSubmitTransaction(ok, input), InvalidRequestError);
    const domainAccepts = accepts(
      () =>
        WagerTransaction.create({
          id: "id-1",
          providerId: String(input.providerId),
          externalTransactionId: String(input.externalTransactionId),
          idempotencyKey: KEY,
          payloadHash: "hash",
          walletId: WALLET,
          playerId: PLAYER,
          roundId: String(input.roundId),
          gameId: String(input.gameId),
          kind: input.kind as Kind,
          // Straight from the domain's own parser, so the amount is not what this test is about.
          money: Money.from(input.money as { amount: string; currency: string }),
          referenceExternalTransactionId: input.referenceExternalTransactionId as string | undefined,
          createdAt: new Date(),
        }),
      DomainError,
    );
    expect(edgeAccepts).toBe(domainAccepts);
  });
});

function accepts(attempt: () => unknown, refusal: abstract new (...args: never[]) => Error): boolean {
  try {
    attempt();
    return true;
  } catch (error) {
    if (error instanceof refusal) return false;
    throw error;
  }
}

describe("the path parameters", () => {
  test("a transaction id must be a UUID, and is lowercased", () => {
    expect(parseTransactionId(PLAYER.toUpperCase())).toBe(PLAYER);
    for (const bad of ["", "abc", "1", `${PLAYER}x`, undefined])
      expect(fields(() => parseTransactionId(bad))).toEqual(["transactionId"]);
  });

  test("a provider and its transaction id are opaque strings, bounded", () => {
    expect(parseProviderTransactionPath("provider-a", "tx 1")).toEqual({
      providerId: "provider-a",
      externalTransactionId: "tx 1",
    });
    for (const bad of ["", "x".repeat(256), "a\u0000b", undefined]) {
      expect(fields(() => parseProviderTransactionPath(bad, "ok"))).toEqual(["providerId"]);
      expect(fields(() => parseProviderTransactionPath("ok", bad))).toEqual(["externalTransactionId"]);
    }
  });
});
